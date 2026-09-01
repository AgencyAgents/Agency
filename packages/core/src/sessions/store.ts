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
 * only ever leave the last line truncated, never an earlier one. `load()`
 * stops at the first line it can't parse and returns everything before it.
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
    const lines = readFileSync(path, "utf8")
      .split("\n")
      .filter((l) => l.length > 0);
    const entries: SessionEntry[] = [];
    for (const line of lines) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        break; // a partial write from a crash mid-append; nothing after it is trustworthy either
      }
      if (!hasEntryShape(parsed)) break;
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

  /** The most recently created tip: the branch `/resume` continues by default. */
  latestTip(entries: SessionEntry[]): string | undefined {
    const tipIds = new Set(this.tips(entries));
    const tipEntries = entries.filter((e) => tipIds.has(e.id));
    tipEntries.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    return tipEntries.at(-1)?.id;
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
