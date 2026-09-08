import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { assertGitWriteAllowed, type RequestApproval, type ToolPermissionValue } from "@agency/guard";
import { AgencyError, ErrorCode } from "@agency/schema";

export interface SnapshotEntry {
  /** Content hash of the file at the moment it was captured. */
  hash: string;
  path: string;
  capturedAt: string;
}

/**
 * One file-write in the undo journal: the content BEFORE the write (always
 * captured) plus the content AFTER it (recorded once the write + formatter
 * settle), so undo restores the prior state and redo re-applies the new one.
 */
interface JournalRecord {
  before: SnapshotEntry;
  afterHash?: string;
  /** Association with the conversation: the turn that caused the write. */
  ref?: string;
  undone: boolean;
}

export interface UndoOutcome {
  path: string;
}

/** One file captured inside a shadow commit: latest known hash per path. */
export interface ShadowCommitFile {
  path: string;
  hash: string;
}

/**
 * Content-addressed checkpoint manifest written by `shadowCommit`.
 * `commitHash` is the sha256 of the canonical `{ sessionId, message,
 * createdAt, files }` payload, so identical checkpoints share one file.
 */
export interface ShadowCommitManifest {
  commitHash: string;
  sessionId: string;
  message: string;
  createdAt: string;
  files: ShadowCommitFile[];
}

export interface ShadowCommitOutcome {
  commitHash: string;
  files: ShadowCommitFile[];
}

/** Kill ceiling for each git child spawned by `materializeShadowCommit`. */
export const SHADOW_GIT_TIMEOUT_MS = 30_000;

/** One git invocation result, surfaced so tests can count spawns. */
export interface ShadowGitResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** Injectable git runner: defaults to `spawnSync(git, …)`; tests pass a counter. */
export type ShadowGitRunner = (args: string[], opts: { cwd: string }) => ShadowGitResult;

export interface MaterializeShadowCommitOptions {
  /** Git worktree that receives the commit (a tmpdir repo in tests, never the agency repo). */
  targetDir: string;
  /**
   * Session scope root: manifest paths outside it are skipped and never
   * touched on disk. Defaults to `targetDir`.
   */
  sessionRoot?: string;
  /** Git-write gate inputs (Todo 7): checked FIRST, before any git spawn. */
  permissions?: Record<string, ToolPermissionValue>;
  nonInteractive?: boolean;
  ask?: RequestApproval;
  /** Injectable git runner (spawn counter in tests). */
  runGit?: ShadowGitRunner;
  gitBin?: string;
  timeoutMs?: number;
}

export interface MaterializeShadowCommitOutcome {
  /** The shadow manifest id (journal-to-commit correlation id). */
  commitHash: string;
  /** The real git commit sha created in `targetDir`. */
  gitCommit: string;
  /** Repo-relative paths written from manifest blobs. */
  files: string[];
}

/** Options for `restoreShadowCommit` (Todo 9): blobs back into the worktree. */
export interface RestoreShadowCommitOptions {
  /** Worktree that receives the blob contents (a tmpdir in tests, never the agency repo). */
  targetDir: string;
  /**
   * Session scope root: manifest paths outside it are skipped and never
   * touched on disk. Defaults to `targetDir`.
   */
  sessionRoot?: string;
}

export interface RestoreShadowCommitOutcome {
  /** The shadow manifest id that was restored. */
  commitHash: string;
  /** Repo-relative paths written from manifest blobs. */
  files: string[];
  /** Count of files written (equals `files.length`). */
  restored: number;
}

/**
 * Additive journal correlation line appended after a successful materialization.
 * Manifest lines in `shadow-journal.jsonl` are untouched; the `kind` marker
 * distinguishes correlation lines from `ShadowCommitManifest` lines.
 */
export interface ShadowMaterializationRecord {
  kind: "materialized";
  commitHash: string;
  gitCommit: string;
  targetDir: string;
  materializedAt: string;
}

function defaultGitRunner(gitBin: string, timeoutMs: number): ShadowGitRunner {
  return (args, opts) => {
    const result = spawnSync(gitBin, args, { cwd: opts.cwd, encoding: "utf8", timeout: timeoutMs });
    return {
      exitCode: typeof result.status === "number" ? result.status : 1,
      stdout: typeof result.stdout === "string" ? result.stdout : "",
      stderr: typeof result.stderr === "string" ? result.stderr : "",
    };
  };
}

function toRepoRel(sessionRoot: string, filePath: string): string | undefined {
  const rel = isAbsolute(filePath)
    ? relative(resolve(sessionRoot), resolve(filePath))
    : relative(resolve(sessionRoot), resolve(sessionRoot, filePath));
  if (rel.length === 0 || rel === ".." || rel.startsWith(`..${sep}`)) return undefined;
  return rel;
}

function contentHash(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function blobPath(storeDir: string, hash: string): string {
  return join(storeDir, "blobs", hash.slice(0, 2), hash.slice(2));
}

export interface SnapshotStoreOptions {
  /** Durable journal file. Defaults to `<storeDir>/journal.jsonl`; the daemon
   *  passes one file per session (`journals/<sessionId>.journal.jsonl`) so
   *  undo stacks stay session-local. The journal loads on construction, so
   *  undo depth survives daemon restarts. */
  journalFile?: string;
}

/** A persisted journal line: the minimal record needed to rebuild undo/redo. */
interface PersistedJournalRecord {
  before: SnapshotEntry;
  afterHash?: string;
  ref?: string;
  undone: boolean;
}

function isJournalRecord(value: unknown): value is PersistedJournalRecord {
  if (typeof value !== "object" || value === null) return false;
  const r = value as Record<string, unknown>;
  const before = r.before as Record<string, unknown> | undefined;
  return (
    typeof before === "object" &&
    before !== null &&
    typeof before.hash === "string" &&
    typeof before.path === "string" &&
    typeof before.capturedAt === "string" &&
    (r.afterHash === undefined || typeof r.afterHash === "string") &&
    (r.ref === undefined || typeof r.ref === "string") &&
    typeof r.undone === "boolean"
  );
}

const MAX_JOURNAL_RECORDS = 1000;

/**
 * Content-addressed file snapshots, independent of conversation undo (R5's
 * "file undo != conversation undo" distinction). Identical file states across
 * different sessions or edits share one blob, so snapshotting the same
 * unchanged file repeatedly costs nothing extra on disk.
 *
 * Every capture is also journalled in order, which is what file undo/redo is
 * built on: `undo()` restores the most recent unrestored capture, `redo()`
 * re-applies it, and `prune()` reclaims blobs no journal record references
 * anymore (refcount over before+after hashes).
 */
export class SnapshotStore {
  private readonly journal: JournalRecord[] = [];
  private readonly journalFile: string;

  constructor(
    private readonly storeDir: string,
    opts?: SnapshotStoreOptions,
  ) {
    this.journalFile = opts?.journalFile ?? join(storeDir, "journal.jsonl");
    this.loadJournal();
  }

  /** Captures the current on-disk content of `path`, returning its entry. */
  capture(path: string, content: string, ref?: string): SnapshotEntry {
    const entry: SnapshotEntry = {
      hash: this.storeBlob(content),
      path,
      capturedAt: new Date().toISOString(),
    };
    this.journal.push({ before: entry, ...(ref === undefined ? {} : { ref }), undone: false });
    if (this.journal.length > MAX_JOURNAL_RECORDS) this.journal.shift();
    this.persistJournal();
    return entry;
  }

  /** Returns the exact content captured under `entry`, for restoring a file. */
  read(entry: SnapshotEntry): string {
    const blob = blobPath(this.storeDir, entry.hash);
    if (!existsSync(blob)) {
      throw new Error(`snapshot blob missing for ${entry.path} (hash ${entry.hash})`);
    }
    return readFileSync(blob, "utf8");
  }

  /**
   * Records the current on-disk content of `path` as the AFTER state of that
   * path's most recent not-yet-settled journal record. File-mutating tools
   * call this once their write (and any formatter) has finished, so redo has
   * something to restore.
   */
  recordAfter(path: string): void {
    for (let i = this.journal.length - 1; i >= 0; i--) {
      const record = this.journal[i];
      if (record && record.before.path === path) {
        if (record.afterHash === undefined && existsSync(path)) {
          record.afterHash = this.storeBlob(readFileSync(path, "utf8"));
          this.persistJournal();
        }
        return;
      }
    }
  }

  /** Restores the most recent applied capture to its pre-write content. */
  undo(): UndoOutcome | undefined {
    for (let i = this.journal.length - 1; i >= 0; i--) {
      const record = this.journal[i];
      if (record && !record.undone) {
        this.restore(record.before);
        record.undone = true;
        this.persistJournal();
        return { path: record.before.path };
      }
    }
    return undefined;
  }

  /** Re-applies the most recently undone write (whose post-state is known). */
  redo(): UndoOutcome | undefined {
    for (let i = this.journal.length - 1; i >= 0; i--) {
      const record = this.journal[i];
      if (record?.undone && record.afterHash !== undefined) {
        const after: SnapshotEntry = { ...record.before, hash: record.afterHash };
        this.restore(after);
        record.undone = false;
        this.persistJournal();
        return { path: record.before.path };
      }
    }
    return undefined;
  }

  /**
   * Deletes blobs that no journal record references (refcount over every
   * before+after hash) and returns how many were reclaimed. Sibling journals
   * (other sessions' `*.journal.jsonl` next to this store's journal file)
   * count as references too, so one session's prune never orphans another
   * session's undo history. Truly unreferenced blobs — written before
   * journaling existed, or by a crashed run — are the usual reclaims.
   */
  prune(): number {
    const refCounts = new Map<string, number>();
    const count = (hash: string): void => {
      refCounts.set(hash, (refCounts.get(hash) ?? 0) + 1);
    };
    for (const record of this.journal) {
      count(record.before.hash);
      if (record.afterHash !== undefined) count(record.afterHash);
    }
    for (const sibling of this.loadSiblingJournals()) {
      for (const record of sibling) {
        count(record.before.hash);
        if (record.afterHash !== undefined) count(record.afterHash);
      }
    }

    const blobsDir = join(this.storeDir, "blobs");
    if (!existsSync(blobsDir)) return 0;
    let pruned = 0;
    for (const shard of readdirSync(blobsDir)) {
      const shardDir = join(blobsDir, shard);
      for (const file of readdirSync(shardDir)) {
        // Blob files are sharded: <blobs>/<hash[0:2]>/<hash[2:]>.
        const hash = shard + file;
        if ((refCounts.get(hash) ?? 0) > 0) continue;
        rmSync(join(shardDir, file), { force: true });
        pruned += 1;
      }
    }
    return pruned;
  }

  /** Journal length, for tests and callers that want to know undo depth. */
  get depth(): number {
    return this.journal.length;
  }

  /**
   * Journal-only checkpoint over the latest known state per path (each
   * path's most recent afterHash, else its before hash). Writes a
   * content-addressed manifest to `<storeDir>/shadow-commits/<hash>.json`
   * and appends the same record to `<storeDir>/shadow-journal.jsonl`;
   * both writes are best-effort and never throw. No git command runs
   * here — the daemon has no git write permission by default.
   *
   * Future git integration: when a session gains git write permission, a
   * caller can materialize a real commit from the manifest by checking
   * out each file's blob content (`read({hash, path, capturedAt})`) and
   * running `git commit` itself; `commitHash` then serves as the
   * journal-to-commit correlation id (e.g. in the commit message).
   */
  shadowCommit(sessionId: string, message: string): ShadowCommitOutcome {
    if (sessionId.trim().length === 0) {
      throw new AgencyError(ErrorCode.TOOL_ERROR, "shadow commit requires a non-empty session id", {
        source: "snapshot",
        context: {},
      });
    }
    if (message.trim().length === 0) {
      throw new AgencyError(ErrorCode.TOOL_ERROR, "shadow commit requires a non-empty message", {
        source: "snapshot",
        context: { sessionId },
      });
    }
    const latest = new Map<string, string>();
    for (const record of this.journal) {
      latest.set(record.before.path, record.afterHash ?? record.before.hash);
    }
    const files: ShadowCommitFile[] = [...latest.entries()]
      .map(([path, hash]) => ({ path, hash }))
      .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    const createdAt = new Date().toISOString();
    const commitHash = createHash("sha256")
      .update(JSON.stringify({ sessionId, message, createdAt, files }), "utf8")
      .digest("hex");
    const manifest: ShadowCommitManifest = { commitHash, sessionId, message, createdAt, files };
    try {
      mkdirSync(join(this.storeDir, "shadow-commits"), { recursive: true });
      writeFileSync(
        join(this.storeDir, "shadow-commits", `${commitHash}.json`),
        JSON.stringify(manifest, null, 2),
        "utf8",
      );
      appendFileSync(join(this.storeDir, "shadow-journal.jsonl"), `${JSON.stringify(manifest)}\n`, "utf8");
    } catch (error) {
      console.warn(
        `[snapshot] shadow commit persist failed for session ${sessionId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    return { commitHash, files };
  }

  /**
   * Materializes a real git commit from a shadow-commit manifest. The
   * git-write gate (`assertGitWriteAllowed`) runs FIRST: deny,
   * non-interactive, and rejected asks throw typed PERMISSION_DENIED with
   * zero git process spawns. On allow, each in-scope file's exact blob
   * content is written under `targetDir` (repo-relative via `sessionRoot`),
   * committed with the shadow `commitHash` in the message, and the
   * journal gains an additive `{ kind: "materialized", commitHash,
   * gitCommit }` correlation line. Manifest paths outside `sessionRoot`
   * are skipped and never touched. No restore here (Todo 9).
   */
  async materializeShadowCommit(
    commitHash: string,
    options: MaterializeShadowCommitOptions,
  ): Promise<MaterializeShadowCommitOutcome> {
    await assertGitWriteAllowed({
      permissions: options.permissions,
      nonInteractive: options.nonInteractive,
      ask: options.ask,
    });
    if (commitHash.trim().length === 0) {
      throw new AgencyError(ErrorCode.TOOL_ERROR, "materialize requires a non-empty commit hash", {
        source: "snapshot",
        context: {},
      });
    }
    const manifest = this.readShadowCommit(commitHash);
    if (!manifest) {
      throw new AgencyError(ErrorCode.TOOL_ERROR, `unknown shadow commit ${commitHash}`, {
        source: "snapshot",
        context: { commitHash },
      });
    }
    const { targetDir } = options;
    const sessionRoot = options.sessionRoot ?? targetDir;
    const gitBin = options.gitBin ?? "git";
    const timeoutMs = options.timeoutMs ?? SHADOW_GIT_TIMEOUT_MS;
    const runGit = options.runGit ?? defaultGitRunner(gitBin, timeoutMs);
    const gitFailure = (args: string[], result: ShadowGitResult): AgencyError =>
      new AgencyError(ErrorCode.TOOL_ERROR, `git ${args[0] ?? ""} failed: ${result.stderr.trim()}`, {
        source: "snapshot",
        context: { commitHash, exitCode: result.exitCode, stderr: result.stderr.slice(0, 500) },
      });
    const inside = runGit(["rev-parse", "--is-inside-work-tree"], { cwd: targetDir });
    if (inside.exitCode !== 0 || inside.stdout.trim() !== "true") {
      throw new AgencyError(ErrorCode.TOOL_ERROR, `materialize target is not a git repo: ${targetDir}`, {
        source: "snapshot",
        context: { commitHash, targetDir },
      });
    }
    const written: string[] = [];
    for (const file of manifest.files) {
      const rel = toRepoRel(sessionRoot, file.path);
      if (rel === undefined) continue;
      const blob = blobPath(this.storeDir, file.hash);
      if (!existsSync(blob)) {
        throw new AgencyError(ErrorCode.TOOL_ERROR, `snapshot blob missing for ${file.path}`, {
          source: "snapshot",
          context: { commitHash, path: file.path, hash: file.hash },
        });
      }
      const dest = join(resolve(targetDir), rel);
      mkdirSync(dirname(dest), { recursive: true });
      writeFileSync(dest, readFileSync(blob, "utf8"), "utf8");
      written.push(rel);
    }
    const gitRels = written.map((rel) => rel.split(sep).join("/")).sort();
    if (gitRels.length > 0) {
      const add = runGit(["add", "--", ...gitRels], { cwd: targetDir });
      if (add.exitCode !== 0) throw gitFailure(["add"], add);
    }
    const message = `${manifest.message}\n\nshadow-commit: ${manifest.commitHash}`;
    const commitArgs = [
      "-c",
      "user.name=agency",
      "-c",
      "user.email=agency@localhost",
      "commit",
      ...(gitRels.length === 0 ? ["--allow-empty"] : []),
      "-m",
      message,
    ];
    const commit = runGit(commitArgs, { cwd: targetDir });
    if (commit.exitCode !== 0) throw gitFailure(["commit"], commit);
    const rev = runGit(["rev-parse", "HEAD"], { cwd: targetDir });
    if (rev.exitCode !== 0) throw gitFailure(["rev-parse"], rev);
    const gitCommit = rev.stdout.trim();
    const record: ShadowMaterializationRecord = {
      kind: "materialized",
      commitHash: manifest.commitHash,
      gitCommit,
      targetDir: resolve(targetDir),
      materializedAt: new Date().toISOString(),
    };
    try {
      appendFileSync(join(this.storeDir, "shadow-journal.jsonl"), `${JSON.stringify(record)}\n`, "utf8");
    } catch (error) {
      console.warn(
        `[snapshot] materialization journal append failed for ${manifest.commitHash}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    return { commitHash: manifest.commitHash, gitCommit, files: written };
  }

  /**
   * Returns the latest materialization correlation for a shadow commit hash,
   * scanning the journal file so the mapping survives restarts. Manifest
   * lines (no `kind`) are skipped; only additive `materialized` lines match.
   */
  readMaterialization(commitHash: string): ShadowMaterializationRecord | undefined {
    let text: string;
    try {
      text = readFileSync(join(this.storeDir, "shadow-journal.jsonl"), "utf8");
    } catch {
      return undefined;
    }
    let latest: ShadowMaterializationRecord | undefined;
    for (const line of text.split("\n")) {
      if (line.length === 0) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      if (typeof parsed !== "object" || parsed === null) continue;
      const record = parsed as Record<string, unknown>;
      if (
        record.kind === "materialized" &&
        record.commitHash === commitHash &&
        typeof record.gitCommit === "string" &&
        typeof record.targetDir === "string" &&
        typeof record.materializedAt === "string"
      ) {
        latest = parsed as ShadowMaterializationRecord;
      }
    }
    return latest;
  }

  /** Reads a persisted shadow-commit manifest, if the hash exists. */
  readShadowCommit(commitHash: string): ShadowCommitManifest | undefined {
    const file = join(this.storeDir, "shadow-commits", `${commitHash}.json`);
    if (!existsSync(file)) return undefined;
    try {
      const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
      if (typeof parsed !== "object" || parsed === null) return undefined;
      const m = parsed as Record<string, unknown>;
      if (
        typeof m.commitHash !== "string" ||
        typeof m.sessionId !== "string" ||
        typeof m.message !== "string" ||
        typeof m.createdAt !== "string" ||
        !Array.isArray(m.files)
      ) {
        return undefined;
      }
      return parsed as ShadowCommitManifest;
    } catch {
      return undefined;
    }
  }

  restoreShadowCommit(commitHash: string, options: RestoreShadowCommitOptions): RestoreShadowCommitOutcome {
    if (commitHash.trim().length === 0) {
      throw new AgencyError(ErrorCode.TOOL_ERROR, "restore requires a non-empty commit hash", {
        source: "snapshot",
        context: {},
      });
    }
    const manifest = this.readShadowCommit(commitHash);
    if (!manifest) {
      throw new AgencyError(ErrorCode.TOOL_ERROR, `unknown shadow commit ${commitHash}`, {
        source: "snapshot",
        context: { commitHash },
      });
    }
    const { targetDir } = options;
    const sessionRoot = options.sessionRoot ?? targetDir;
    const plan: Array<{ rel: string; hash: string }> = [];
    for (const file of manifest.files) {
      const rel = toRepoRel(sessionRoot, file.path);
      if (rel === undefined) continue;
      const blob = blobPath(this.storeDir, file.hash);
      if (!existsSync(blob)) {
        throw new AgencyError(ErrorCode.TOOL_ERROR, `snapshot blob missing for ${file.path}`, {
          source: "snapshot",
          context: { commitHash, path: file.path, hash: file.hash },
        });
      }
      plan.push({ rel, hash: file.hash });
    }
    const written: string[] = [];
    for (const item of plan) {
      const dest = join(resolve(targetDir), item.rel);
      mkdirSync(dirname(dest), { recursive: true });
      writeFileSync(dest, readFileSync(blobPath(this.storeDir, item.hash), "utf8"), "utf8");
      written.push(item.rel);
    }
    return { commitHash: manifest.commitHash, files: written, restored: written.length };
  }

  /**
   * Single-line frame rendering for undo/redo operations. Returns a compact
   * string suitable for TUI transcript frames: "undo <path>" or "redo <path>"
   * when the operation succeeded, or "undo: nothing to undo" / "redo: nothing
   * to redo" when the journal had no applicable record.
   */
  static renderCall(operation: "undo" | "redo", outcome: UndoOutcome | undefined): string {
    if (!outcome) return `${operation}: nothing to ${operation}`;
    return `${operation} ${outcome.path}`;
  }

  private storeBlob(content: string): string {
    const hash = contentHash(content);
    const blob = blobPath(this.storeDir, hash);
    if (!existsSync(blob)) {
      mkdirSync(join(blob, ".."), { recursive: true });
      writeFileSync(blob, content, "utf8");
    }
    return hash;
  }

  private loadJournal(): void {
    let text: string;
    try {
      text = readFileSync(this.journalFile, "utf8");
    } catch {
      return;
    }
    for (const [offset, line] of text.split("\n").entries()) {
      if (line.length === 0) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch (error) {
        console.warn(
          `[snapshot] corrupt journal line ${offset + 1} in ${this.journalFile} skipped: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        continue;
      }
      if (!isJournalRecord(parsed)) {
        console.warn(`[snapshot] corrupt journal line ${offset + 1} in ${this.journalFile} skipped (shape)`);
        continue;
      }
      this.journal.push({
        before: parsed.before,
        ...(parsed.ref === undefined ? {} : { ref: parsed.ref }),
        ...(parsed.afterHash === undefined ? {} : { afterHash: parsed.afterHash }),
        undone: parsed.undone,
      });
    }
    while (this.journal.length > MAX_JOURNAL_RECORDS) this.journal.shift();
  }

  private persistJournal(): void {
    try {
      mkdirSync(dirname(this.journalFile), { recursive: true });
      const tmp = `${this.journalFile}.tmp`;
      writeFileSync(
        tmp,
        this.journal
          .map((r) =>
            JSON.stringify({
              before: r.before,
              ...(r.afterHash === undefined ? {} : { afterHash: r.afterHash }),
              ...(r.ref === undefined ? {} : { ref: r.ref }),
              undone: r.undone,
            }),
          )
          .join("\n") + (this.journal.length > 0 ? "\n" : ""),
        "utf8",
      );
      renameSync(tmp, this.journalFile);
    } catch (error) {
      console.warn(
        `[snapshot] journal persist failed for ${this.journalFile}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  private loadSiblingJournals(): PersistedJournalRecord[][] {
    const dir = dirname(this.journalFile);
    const own = basename(this.journalFile);
    let files: string[];
    try {
      files = readdirSync(dir);
    } catch {
      return [];
    }
    const out: PersistedJournalRecord[][] = [];
    for (const file of files) {
      if (file === own || file.endsWith(".tmp")) continue;
      if (file !== "journal.jsonl" && !file.endsWith(".journal.jsonl")) continue;
      try {
        const text = readFileSync(join(dir, file), "utf8");
        const records: PersistedJournalRecord[] = [];
        for (const line of text.split("\n")) {
          if (line.length === 0) continue;
          const parsed: unknown = JSON.parse(line);
          if (isJournalRecord(parsed)) records.push(parsed);
        }
        out.push(records);
      } catch {
        // Unreadable sibling journal: not ours to prune by, skip it.
      }
    }
    return out;
  }

  private restore(entry: SnapshotEntry): void {
    const content = this.read(entry);
    mkdirSync(join(entry.path, ".."), { recursive: true });
    writeFileSync(entry.path, content, "utf8");
  }
}
