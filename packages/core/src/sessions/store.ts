import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Message } from "@agency/schema";
import { migrate } from "@agency/schema";
import type { Logger } from "../logger.ts";
import type { CompactionSummaryEntry, SessionEntry } from "./entry.ts";
import {
  hasEntryShape,
  isCompactionSummaryEntry,
  isMessageEntry,
  newEntryId,
  SESSION_SCHEMA_VERSION,
  sessionMigrations,
} from "./entry.ts";

export interface SessionMeta {
  id: string;
  createdAt: string;
}

function sessionPath(sessionsDir: string, sessionId: string): string {
  return join(sessionsDir, `${sessionId}.jsonl`);
}

/** How long append waits for a lock another process holds before giving up. */
const LOCK_TIMEOUT_MS = 5_000;
/** A lock older than this is crashed-process debris and is broken. */
const LOCK_STALE_MS = 10_000;

interface LoadCache {
  entries: SessionEntry[];
  /** File size the entries were parsed up to (always the whole file). */
  statSize: number;
  statMtimeMs: number;
  /** Number of newlines consumed; tail reads continue line numbering from it. */
  lineCount: number;
  /** False when the file ended mid-line (crash debris): the next append would
   *  merge onto that garbage line, so the cache is dropped instead of extended. */
  boundaryClean: boolean;
}

/**
 * Append-only JSONL per session, one flushed line per entry. The tree lives
 * in the parentId links between entries in that single file: a fork is just
 * a later entry whose parentId points somewhere other than the previous tip,
 * so multiple branches can coexist in one file without ever rewriting it.
 *
 * Crash recovery falls out of the write granularity for free: each append is
 * one complete line (written without blocking the event loop since A3; the
 * awaited promise is the ordering point), so a process killed mid-write can
 * only ever leave one line truncated, never mangle an earlier one. `load()`
 * warns on and skips any line it can't parse or shape-check; lines are
 * independently flushed, so a corrupt line doesn't vouch for its neighbors and
 * the valid entries around it still load instead of being silently dropped.
 *
 * Appends take a per-session advisory lock file (O_EXCL create + stale
 * breaking; portable across Windows/POSIX), so two processes appending to the
 * same session serialize instead of interleaving partial lines. `load()` is
 * served from a per-session cache that tail-reads only the bytes appended
 * since the last parse, keeping repeated per-turn loads O(new entries).
 */
export class SessionStore {
  private readonly caches = new Map<string, LoadCache>();
  private bus?: { emit: (event: string, payload: unknown) => void };
  private logger?: Logger;

  constructor(
    private readonly sessionsDir: string,
    opts?: { bus?: { emit: (event: string, payload: unknown) => void }; logger?: Logger },
  ) {
    this.bus = opts?.bus;
    this.logger = opts?.logger;
  }

  setBus(bus: { emit: (event: string, payload: unknown) => void }): void {
    this.bus = bus;
  }

  /** Returns the event bus if one was set via constructor or setBus(). */
  getBus(): { emit: (event: string, payload: unknown) => void } | undefined {
    return this.bus;
  }

  create(sessionId: string = newEntryId()): SessionMeta {
    mkdirSync(this.sessionsDir, { recursive: true });
    const path = sessionPath(this.sessionsDir, sessionId);
    if (!existsSync(path)) writeFileSync(path, "");
    this.caches.delete(sessionId);
    try {
      this.bus?.emit("session.created", { sessionId });
      this.bus?.emit("event", { event: "session.created", payload: { sessionId } });
    } catch {
      /* best-effort event emission: bus listeners must not break session creation */
    }
    return { id: sessionId, createdAt: new Date().toISOString() };
  }

  /**
   * Appends one entry as its own flushed JSONL line, under the session's
   * advisory lock. Async (A3: no blocking I/O on an interactive event loop),
   * and order-preserving under await-sequential use: each append is a
   * complete line, so a crash can only ever leave the tail line truncated.
   * Callers that need entry A ordered before entry B must await A before
   * starting B: the returned promise is the ordering point.
   */
  async append(
    sessionId: string,
    entry: { type: string; parentId: string | null } & Record<string, unknown>,
  ): Promise<SessionEntry> {
    await mkdir(this.sessionsDir, { recursive: true });
    const path = sessionPath(this.sessionsDir, sessionId);
    const lockPath = `${path}.lock`;
    await this.acquireLock(lockPath);
    try {
      const full: SessionEntry = {
        id: newEntryId(),
        schemaVersion: SESSION_SCHEMA_VERSION,
        createdAt: new Date().toISOString(),
        ...entry,
      };
      const line = `${JSON.stringify(full)}\n`;
      const oldSize = this.sizeOf(path);
      await appendFile(path, line);

      const cached = this.caches.get(sessionId);
      if (cached?.boundaryClean && oldSize === cached.statSize) {
        const stat = statSync(path);
        cached.entries.push(full);
        cached.statSize = stat.size;
        cached.statMtimeMs = stat.mtimeMs;
        cached.lineCount += 1;
      } else {
        this.caches.delete(sessionId);
      }
      return full;
    } finally {
      this.releaseLock(lockPath);
    }
  }

  load(sessionId: string): SessionEntry[] {
    const path = sessionPath(this.sessionsDir, sessionId);
    let stat: ReturnType<typeof statSync>;
    try {
      stat = statSync(path);
    } catch {
      this.caches.delete(sessionId);
      return [];
    }

    const cached = this.caches.get(sessionId);
    if (cached && cached.statSize === stat.size && cached.statMtimeMs === stat.mtimeMs) {
      return [...cached.entries];
    }

    // Only extend the cache from a line-aligned boundary: a file that ended
    // mid-line (crash debris) could have had garbage merged onto it.
    if (cached?.boundaryClean && stat.size > cached.statSize) {
      const tail = this.readRange(path, cached.statSize, stat.size - cached.statSize);
      const text = tail.toString("utf8");
      const entries = this.parseLines(text, sessionId, cached.lineCount);
      cached.entries.push(...entries);
      cached.statSize = stat.size;
      cached.statMtimeMs = stat.mtimeMs;
      cached.lineCount += countNewlines(text);
      cached.boundaryClean = text.endsWith("\n") || text.length === 0;
      return [...cached.entries];
    }

    const buf = readFileSync(path);
    const text = buf.toString("utf8");
    const entries = this.parseLines(text, sessionId, 0);
    this.caches.set(sessionId, {
      entries,
      statSize: stat.size,
      statMtimeMs: stat.mtimeMs,
      lineCount: countNewlines(text),
      boundaryClean: text.endsWith("\n") || text.length === 0,
    });
    return [...entries];
  }

  list(): string[] {
    if (!existsSync(this.sessionsDir)) return [];
    return readdirSync(this.sessionsDir)
      .filter((f) => f.endsWith(".jsonl") && !f.endsWith(".trace.jsonl"))
      .map((f) => f.slice(0, -".jsonl".length));
  }

  delete(sessionId: string): void {
    rmSync(sessionPath(this.sessionsDir, sessionId), { force: true });
    rmSync(join(this.sessionsDir, `${sessionId}.trace.jsonl`), { force: true });
    if (existsSync(this.sessionsDir)) {
      for (const f of readdirSync(this.sessionsDir)) {
        if (f.startsWith(`${sessionId}.`) && f.endsWith(".cassette.json")) {
          rmSync(join(this.sessionsDir, f), { force: true });
        }
      }
    }
    this.caches.delete(sessionId);
  }

  /**
   * Starts a new branch in the same file: appends a `branch_summary` entry
   * whose parentId is `options.fromTipId` (default: the session's latest
   * tip), so the fork shares all history up to that point but new entries
   * chain from the returned entry. Unlike `clone`, nothing is copied.
   */
  async fork(sessionId: string, options: { fromTipId?: string; label?: string } = {}): Promise<SessionEntry> {
    const parentId = options.fromTipId ?? this.latestTip(this.load(sessionId)) ?? null;
    return await this.append(sessionId, {
      type: "branch_summary",
      parentId,
      label: options.label ?? "forked",
    });
  }

  /** Every id that is nobody's parent: a live or abandoned branch tip. */
  tips(entries: SessionEntry[]): string[] {
    const parented = new Set(entries.map((e) => e.parentId).filter((p): p is string => p !== null));
    return entries.filter((e) => !parented.has(e.id)).map((e) => e.id);
  }

  /** The most recently created tip: the branch `/resume` continues by default.
   *  Same-millisecond entries (identical createdAt) tie-break by position in
   *  `entries` (file order, i.e. creation order), so the result never depends
   *  on sort stability or locale. */
  latestTip(entries: SessionEntry[]): string | undefined {
    const tipIds = new Set(this.tips(entries));
    let latest: { id: string; createdAt: string; index: number } | undefined;
    for (const [index, entry] of entries.entries()) {
      if (!tipIds.has(entry.id)) continue;
      if (
        latest === undefined ||
        entry.createdAt > latest.createdAt ||
        (entry.createdAt === latest.createdAt && index > latest.index)
      ) {
        latest = { id: entry.id, createdAt: entry.createdAt, index };
      }
    }
    return latest?.id;
  }

  /** Root-to-tip ancestry for `tipId`, in chronological order. */
  chainFor(entries: SessionEntry[], tipId: string): SessionEntry[] {
    const byId = new Map(entries.map((e) => [e.id, e]));
    const chain: SessionEntry[] = [];
    let currentId: string | null = tipId;
    while (currentId !== null) {
      const entry: SessionEntry | undefined = byId.get(currentId);
      if (!entry) break;
      chain.push(entry);
      currentId = entry.parentId;
    }
    return chain.reverse();
  }

  /** The message list a model would see for the branch ending at `tipId`:
   *  message entries in order, with any compaction_summary rendered as a
   *  synthetic message standing in for everything it replaced. */
  messagesFor(entries: SessionEntry[], tipId: string): Message[] {
    const messages: Message[] = [];
    for (const entry of this.chainFor(entries, tipId)) {
      if (isMessageEntry(entry)) {
        messages.push(entry.message);
      } else if (isCompactionSummaryEntry(entry)) {
        messages.push(compactionSummaryMessage(entry));
      }
    }
    return messages;
  }

  /** A full independent copy of `sessionId` under a new id: unlike a fork
   *  (a new tip within the same file), a clone shares nothing afterward. */
  clone(sessionId: string, newSessionId: string = newEntryId()): SessionMeta {
    mkdirSync(this.sessionsDir, { recursive: true });
    const src = sessionPath(this.sessionsDir, sessionId);
    const dest = sessionPath(this.sessionsDir, newSessionId);
    writeFileSync(dest, existsSync(src) ? readFileSync(src) : "");
    this.caches.delete(newSessionId);
    return { id: newSessionId, createdAt: new Date().toISOString() };
  }

  /** Raw entries for `/export`, unknown types included verbatim (R5). */
  export(sessionId: string): SessionEntry[] {
    return this.load(sessionId);
  }

  /**
   * Roll a session back to `tipId` (null clears it): only the tip ancestry
   * is kept, so an undone turn leaves no orphaned entries behind.
   */
  async rollback(sessionId: string, tipId: string | null): Promise<SessionEntry[]> {
    const entries = this.load(sessionId);
    if (tipId !== null && !entries.some((e) => e.id === tipId)) {
      throw new Error(`unknown tip: ${tipId}`);
    }
    const kept = tipId === null ? [] : this.chainFor(entries, tipId);
    const path = sessionPath(this.sessionsDir, sessionId);
    await mkdir(this.sessionsDir, { recursive: true });
    const lockPath = `${path}.lock`;
    await this.acquireLock(lockPath);
    try {
      await writeFile(path, kept.map((e) => `${JSON.stringify(e)}\n`).join(""));
      this.caches.delete(sessionId);
      return kept;
    } finally {
      this.releaseLock(lockPath);
    }
  }

  private parseLines(text: string, sessionId: string, firstLine: number): SessionEntry[] {
    const entries: SessionEntry[] = [];
    for (const [offset, line] of text.split("\n").entries()) {
      if (line.length === 0) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch (error) {
        this.logger?.warn(
          `[sessions] corrupt line ${firstLine + offset + 1} in ${sessionId}.jsonl skipped (invalid JSON): ${error instanceof Error ? error.message : String(error)}`,
        );
        if (!this.logger)
          console.warn(
            `[sessions] corrupt line ${firstLine + offset + 1} in ${sessionId}.jsonl skipped (invalid JSON): ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        continue;
      }
      if (!hasEntryShape(parsed)) {
        this.logger?.warn(
          `[sessions] corrupt line ${firstLine + offset + 1} in ${sessionId}.jsonl skipped (not a session entry)`,
        );
        if (!this.logger)
          console.warn(
            `[sessions] corrupt line ${firstLine + offset + 1} in ${sessionId}.jsonl skipped (not a session entry)`,
          );
        continue;
      }
      // Forward-migrate entries from older schema versions so the rest of
      // the system always sees entries at the current schema version.
      let entry: SessionEntry = parsed;
      if (entry.schemaVersion < SESSION_SCHEMA_VERSION) {
        try {
          entry = migrate(entry, sessionMigrations, SESSION_SCHEMA_VERSION) as SessionEntry;
        } catch (error) {
          this.logger?.warn(
            `[sessions] line ${firstLine + offset + 1} in ${sessionId}.jsonl migration failed: ${error instanceof Error ? error.message : String(error)}`,
          );
          if (!this.logger)
            console.warn(
              `[sessions] line ${firstLine + offset + 1} in ${sessionId}.jsonl migration failed: ${
                error instanceof Error ? error.message : String(error)
              }`,
            );
          continue;
        }
      }
      entries.push(entry);
    }
    return entries;
  }

  private sizeOf(path: string): number {
    try {
      return statSync(path).size;
    } catch {
      return 0;
    }
  }

  private readRange(path: string, position: number, length: number): Buffer {
    const buf = Buffer.alloc(length);
    const fd = openSync(path, "r");
    try {
      let read = 0;
      while (read < length) {
        const bytes = readSync(fd, buf, read, length - read, position + read);
        if (bytes <= 0) break;
        read += bytes;
      }
      return read === length ? buf : buf.subarray(0, read);
    } finally {
      closeSync(fd);
    }
  }

  private async acquireLock(lockPath: string): Promise<void> {
    const deadline = Date.now() + LOCK_TIMEOUT_MS;
    while (true) {
      try {
        const fd = openSync(lockPath, "wx");
        closeSync(fd);
        return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        try {
          if (Date.now() - statSync(lockPath).mtimeMs > LOCK_STALE_MS) rmSync(lockPath, { force: true });
        } catch {
          // Vanished between the failed create and the stat: retry immediately.
        }
        if (Date.now() >= deadline) {
          throw new Error(`timed out waiting for session lock: ${lockPath}`);
        }
        await sleep(5);
      }
    }
  }

  private releaseLock(lockPath: string): void {
    rmSync(lockPath, { force: true });
  }
}

function countNewlines(text: string): number {
  let count = 0;
  for (const ch of text) if (ch === "\n") count++;
  return count;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function compactionSummaryMessage(entry: SessionEntry & CompactionSummaryEntry): Message {
  return {
    role: "user",
    content: [{ type: "text", text: `[earlier conversation compacted]\n${entry.summary}` }],
  };
}
