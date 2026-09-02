import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { Message } from "@agency/schema";
import type { CompactionSummaryEntry, SessionEntry } from "./entry.ts";
import {
  hasEntryShape,
  isCompactionSummaryEntry,
  isMessageEntry,
  newEntryId,
  SESSION_SCHEMA_VERSION,
} from "./entry.ts";

export interface SessionMeta {
  id: string;
  createdAt: string;
}

function sessionPath(sessionsDir: string, sessionId: string): string {
  return join(sessionsDir, `${sessionId}.jsonl`);
}

/**
 * Append-only JSONL per session, one flushed line per entry. The tree lives
 * in the parentId links between entries in that single file: a fork is just
 * a later entry whose parentId points somewhere other than the previous tip,
 * so multiple branches can coexist in one file without ever rewriting it.
 *
 * Crash recovery falls out of the write granularity for free: each append is
 * one complete, synchronously flushed line, so a process killed mid-write can
 * only ever leave one line truncated, never mangle an earlier one. `load()`
 * warns on and skips any line it can't parse or shape-check; lines are
 * independently flushed, so a corrupt line doesn't vouch for its neighbors and
 * the valid entries around it still load instead of being silently dropped.
 */
export class SessionStore {
  constructor(private readonly sessionsDir: string) {}

  create(sessionId: string = newEntryId()): SessionMeta {
    mkdirSync(this.sessionsDir, { recursive: true });
    const path = sessionPath(this.sessionsDir, sessionId);
    if (!existsSync(path)) writeFileSync(path, "");
    return { id: sessionId, createdAt: new Date().toISOString() };
  }

  append(
    sessionId: string,
    entry: { type: string; parentId: string | null } & Record<string, unknown>,
  ): SessionEntry {
    mkdirSync(this.sessionsDir, { recursive: true });
    const full: SessionEntry = {
      id: newEntryId(),
      schemaVersion: SESSION_SCHEMA_VERSION,
      createdAt: new Date().toISOString(),
      ...entry,
    };
    appendFileSync(sessionPath(this.sessionsDir, sessionId), `${JSON.stringify(full)}\n`);
    return full;
  }

  load(sessionId: string): SessionEntry[] {
    const path = sessionPath(this.sessionsDir, sessionId);
    if (!existsSync(path)) return [];
    const lines = readFileSync(path, "utf8").split("\n");
    const entries: SessionEntry[] = [];
    for (const [index, line] of lines.entries()) {
      if (line.length === 0) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch (error) {
        // crash mid-append or external corruption; lines are independently
        // flushed, so skip this one loudly instead of silently dropping the tail
        console.warn(
          `[sessions] corrupt line ${index + 1} in ${sessionId}.jsonl skipped (invalid JSON): ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        continue;
      }
      if (!hasEntryShape(parsed)) {
        console.warn(
          `[sessions] corrupt line ${index + 1} in ${sessionId}.jsonl skipped (not a session entry)`,
        );
        continue;
      }
      entries.push(parsed);
    }
    return entries;
  }

  list(): string[] {
    if (!existsSync(this.sessionsDir)) return [];
    return readdirSync(this.sessionsDir)
      .filter((f) => f.endsWith(".jsonl"))
      .map((f) => f.slice(0, -".jsonl".length));
  }

  delete(sessionId: string): void {
    rmSync(sessionPath(this.sessionsDir, sessionId), { force: true });
  }

  /** Every id that is nobody's parent: a live or abandoned branch tip. */
  tips(entries: SessionEntry[]): string[] {
    const parented = new Set(entries.map((e) => e.parentId).filter((p): p is string => p !== null));
    return entries.filter((e) => !parented.has(e.id)).map((e) => e.id);
  }

  /** The most recently created tip: the branch `/resume` continues by default.
   *  Same-millisecond entries (identical createdAt) tie-break by position in
   *  `entries` — file order, i.e. creation order — so the result never depends
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
    return { id: newSessionId, createdAt: new Date().toISOString() };
  }

  /** Raw entries for `/export`, unknown types included verbatim (R5). */
  export(sessionId: string): SessionEntry[] {
    return this.load(sessionId);
  }
}

function compactionSummaryMessage(entry: SessionEntry & CompactionSummaryEntry): Message {
  return {
    role: "user",
    content: [{ type: "text", text: `[earlier conversation compacted]\n${entry.summary}` }],
  };
}
