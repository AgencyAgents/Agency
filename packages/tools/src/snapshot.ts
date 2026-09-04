import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

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
