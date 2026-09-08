import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Logger } from "../logger.ts";
import type { SessionEntry } from "./entry.ts";
import { isCompactionSummaryEntry } from "./entry.ts";
import type { SessionStore } from "./store.ts";

/** One durable fact, namespaced to its session. Minimal by design. */
export interface MemoryFact {
  id: string;
  sessionId: string;
  text: string;
  createdAt: string;
  source: string;
}

/** Pluggable backend; JSONL file is the default, no new DB. */
export interface MemoryStorage {
  load(sessionId: string): Promise<MemoryFact[]>;
  save(sessionId: string, facts: readonly MemoryFact[]): Promise<void>;
  append(sessionId: string, fact: MemoryFact): Promise<void>;
}

/** Oversized text is truncated, never rejected (probe: writer keeps working). */
export const MAX_FACT_CHARS = 4_000;
const TRUNC_MARKER = " [truncated]";

export function capFactText(text: string): string {
  if (text.length <= MAX_FACT_CHARS) return text;
  return text.slice(0, MAX_FACT_CHARS - TRUNC_MARKER.length) + TRUNC_MARKER;
}

/** True for a parsed line worth keeping; unknown extra fields pass through ignored. */
export function hasFactShape(raw: unknown, sessionId: string): raw is MemoryFact {
  if (typeof raw !== "object" || raw === null) return false;
  const r = raw as Record<string, unknown>;
  return (
    typeof r.id === "string" &&
    r.sessionId === sessionId &&
    typeof r.text === "string" &&
    r.text.length > 0 &&
    typeof r.createdAt === "string" &&
    (r.source === undefined || typeof r.source === "string")
  );
}

/** JSONL sidecar backend: `<sessionsDir>/<sessionId>.memory.jsonl`. */
export class JsonlFileMemoryStorage implements MemoryStorage {
  private logger?: Logger;

  constructor(
    private readonly sessionsDir: string,
    opts?: { logger?: Logger },
  ) {
    this.logger = opts?.logger;
  }

  pathFor(sessionId: string): string {
    return join(this.sessionsDir, `${sessionId}.memory.jsonl`);
  }

  async load(sessionId: string): Promise<MemoryFact[]> {
    let text: string;
    try {
      text = await readFile(this.pathFor(sessionId), "utf8");
    } catch {
      return [];
    }
    const facts: MemoryFact[] = [];
    for (const [offset, line] of text.split("\n").entries()) {
      if (line.length === 0) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch (error) {
        this.warn(`corrupt memory line ${offset + 1} in ${sessionId}.memory.jsonl skipped: ${msg(error)}`);
        continue;
      }
      if (!hasFactShape(parsed, sessionId)) {
        this.warn(`memory line ${offset + 1} in ${sessionId}.memory.jsonl skipped (shape or session mismatch)`);
        continue;
      }
      facts.push({ ...parsed, source: parsed.source ?? "unknown" });
    }
    return facts;
  }

  async save(sessionId: string, facts: readonly MemoryFact[]): Promise<void> {
    await mkdir(this.sessionsDir, { recursive: true });
    await writeFile(this.pathFor(sessionId), facts.map((f) => `${JSON.stringify(f)}\n`).join(""), "utf8");
  }

  async append(sessionId: string, fact: MemoryFact): Promise<void> {
    await mkdir(this.sessionsDir, { recursive: true });
    await appendFile(this.pathFor(sessionId), `${JSON.stringify(fact)}\n`, "utf8");
  }

  private warn(message: string): void {
    if (this.logger) this.logger.warn(`[memory] ${message}`);
    else console.warn(`[memory] ${message}`);
  }
}

function msg(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export interface MemoryStoreOptions {
  storage?: MemoryStorage;
  logger?: Logger;
}

/**
 * Per-session durable facts over a pluggable storage (default JSONL sidecar).
 * Facts survive restarts via load-on-boot (lazy per session, plus `preload`).
 */
export class MemoryStore {
  private readonly storage: MemoryStorage;
  private readonly logger?: Logger;
  private readonly cache = new Map<string, MemoryFact[]>();
  private readonly loaded = new Set<string>();
  private detachFns: Array<() => void> = [];

  constructor(sessionsDir: string, opts?: MemoryStoreOptions) {
    this.storage = opts?.storage ?? new JsonlFileMemoryStorage(sessionsDir, { logger: opts?.logger });
    this.logger = opts?.logger;
  }

  /** Records one fact; empty text throws, oversized text is capped. */
  async record(sessionId: string, text: string, source = "turn"): Promise<MemoryFact> {
    if (text.trim().length === 0) throw new Error("memory fact text must be non-empty");
    const fact: MemoryFact = {
      id: randomUUID(),
      sessionId,
      text: capFactText(text),
      createdAt: new Date().toISOString(),
      source,
    };
    await this.storage.append(sessionId, fact);
    (this.cache.get(sessionId) ?? this.cache.set(sessionId, []).get(sessionId) as MemoryFact[]).push(fact);
    this.loaded.add(sessionId);
    return fact;
  }

  /** Cached facts, loading from disk on first touch (restart proof). */
  async recall(sessionId: string): Promise<MemoryFact[]> {
    if (!this.loaded.has(sessionId)) await this.load(sessionId);
    return [...(this.cache.get(sessionId) ?? [])];
  }

  /** (Re)loads one session from disk, replacing the cache. */
  async load(sessionId: string): Promise<MemoryFact[]> {
    const facts = await this.storage.load(sessionId);
    this.cache.set(sessionId, [...facts]);
    this.loaded.add(sessionId);
    return [...facts];
  }

  /** Warms the cache for known sessions at daemon boot. */
  async preload(sessionIds: string[]): Promise<void> {
    for (const id of sessionIds) await this.load(id);
  }

  /** Drops one session from cache (pairs with SessionStore.delete). */
  clear(sessionId: string): void {
    this.cache.delete(sessionId);
    this.loaded.delete(sessionId);
  }

  /**
   * Indexes durable facts from session appends: compaction summaries land
   * here automatically since compact() writes through SessionStore.append.
   * Best-effort: indexing never throws into the session path.
   */
  attach(store: SessionStore): () => void {
    const listener = (sessionId: string, entry: SessionEntry): void => {
      void this.indexEntry(sessionId, entry).catch((error) => {
        if (this.logger) this.logger.warn(`[memory] index failed: ${msg(error)}`);
        else console.warn(`[memory] index failed: ${msg(error)}`);
      });
    };
    store.addAppendListener(listener);
    const detach = (): void => store.removeAppendListener(listener);
    this.detachFns.push(detach);
    return detach;
  }

  detach(): void {
    for (const fn of this.detachFns.splice(0)) fn();
  }

  private async indexEntry(sessionId: string, entry: SessionEntry): Promise<void> {
    if (!isCompactionSummaryEntry(entry)) return;
    if (typeof entry.summary !== "string" || entry.summary.trim().length === 0) return;
    const facts = await this.recall(sessionId);
    const marker = `compaction:${entry.id}`;
    if (facts.some((f) => f.source === marker)) return;
    await this.record(sessionId, entry.summary, marker);
  }
}
