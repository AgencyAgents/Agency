/**
 * The stable hook surface (R7). Emitted from day one even though nothing consumes
 * it yet in v1; the TUI listens now, plugins listen later, without touching emitters.
 */

import type { Logger } from "./logger.ts";

export interface AgencyEvents {
  "config.loaded": { config: unknown };
  "log.entry": { level: string; message: string; traceId?: string };
  "tool.execute.before": {
    tool: string;
    input: Record<string, unknown>;
    sessionId?: string;
    turnId?: string;
  };
  "tool.execute.after": {
    tool: string;
    input: Record<string, unknown>;
    result: { content: string; isError?: boolean };
    sessionId?: string;
    turnId?: string;
  };
  "session.created": { sessionId: string };
  "session.compacted": { sessionId: string; tipId: string };
  "session.idle": { sessionId?: string };
  "file.edited": { path: string };
  "permission.asked": { tool: string; command?: string; path?: string; decision: string };
  "permission.replied": { tool: string; command?: string; path?: string; decision: string };
  "shell.env": { env: Record<string, string> };
  "session.start": { sessionId: string; workspaceRoot: string };
  "prompt.submit": { sessionId: string; prompt: string };
  "subagent.start": { sessionId: string; handle: string; parentSessionId: string };
  "board.item.complete": { itemId: string; status: string };
  "pre.merge": { sessionId: string; restored: string[] };
  "cost.threshold": { reason: string; sessionId?: string };
  event: { event: string; payload: unknown };
}

type Listener<T = unknown> = (payload: T) => void | Promise<void>;

function escapeRegExpPart(s: string): string {
  return s.replace(/[.+^${}()|[\]\\]/g, "\\$&");
}

function matchesPattern(pattern: string, event: string): boolean {
  if (pattern === event) return true;
  if (!pattern.includes("*")) return false;
  const escaped = pattern.split("*").map(escapeRegExpPart).join(".*");
  return new RegExp(`^${escaped}$`).test(event);
}

export class EventBus<_Events extends object = AgencyEvents> {
  private readonly listeners = new Map<string, Set<Listener>>();
  private logger?: Logger;

  setLogger(logger: Logger): void {
    this.logger = logger;
  }

  on(pattern: string, listener: Listener): () => void {
    const set = this.listeners.get(pattern) ?? new Set();
    set.add(listener);
    this.listeners.set(pattern, set);
    return () => {
      set.delete(listener);
      if (set.size === 0) this.listeners.delete(pattern);
    };
  }

  off(pattern: string, listener: Listener): void {
    const set = this.listeners.get(pattern);
    if (!set) return;
    set.delete(listener);
    if (set.size === 0) this.listeners.delete(pattern);
  }

  /** Synchronous fire-and-forget: every matching listener is invoked, async rejections and throws are captured and logged, never break the loop. */
  emit(event: string, payload: unknown): void {
    for (const [pattern, set] of this.listeners) {
      if (!matchesPattern(pattern, event)) continue;
      for (const listener of [...set]) {
        try {
          const result = (listener as Listener)(payload);
          if (result !== undefined && typeof (result as Promise<void>).catch === "function") {
            (result as Promise<void>).catch((err) => {
              this.logger?.error(`[events] async listener for "${event}" (pattern "${pattern}") threw:`, {
                error: String(err),
              });
              if (!this.logger)
                console.error(`[events] async listener for "${event}" (pattern "${pattern}") threw:`, err);
            });
          }
        } catch (err) {
          this.logger?.error(`[events] listener for "${event}" (pattern "${pattern}") threw:`, {
            error: String(err),
          });
          if (!this.logger)
            console.error(`[events] listener for "${event}" (pattern "${pattern}") threw:`, err);
        }
      }
    }
  }

  /** Async version: awaits each matching listener sequentially, still isolates errors (each throw is captured and logged). */
  async emitAsync(event: string, payload: unknown): Promise<void> {
    for (const [pattern, set] of this.listeners) {
      if (!matchesPattern(pattern, event)) continue;
      for (const listener of [...set]) {
        try {
          await (listener as Listener)(payload);
        } catch (err) {
          this.logger?.error(`[events] async listener for "${event}" (pattern "${pattern}") threw:`, {
            error: String(err),
          });
          if (!this.logger)
            console.error(`[events] async listener for "${event}" (pattern "${pattern}") threw:`, err);
        }
      }
    }
  }

  /** Collect results: returns errors per listener so callers like tool.execute.before can short-circuit. Errors are still logged. */
  async emitCollect(event: string, payload: unknown): Promise<{ errors: unknown[] }> {
    const errors: unknown[] = [];
    for (const [pattern, set] of this.listeners) {
      if (!matchesPattern(pattern, event)) continue;
      for (const listener of [...set]) {
        try {
          await (listener as Listener)(payload);
        } catch (err) {
          this.logger?.error(`[events] listener for "${event}" (pattern "${pattern}") threw:`, {
            error: String(err),
          });
          if (!this.logger)
            console.error(`[events] listener for "${event}" (pattern "${pattern}") threw:`, err);
          errors.push(err);
        }
      }
    }
    return { errors };
  }

  clear(): void {
    this.listeners.clear();
  }

  listenerCount(pattern?: string): number {
    if (pattern !== undefined) return this.listeners.get(pattern)?.size ?? 0;
    let total = 0;
    for (const s of this.listeners.values()) total += s.size;
    return total;
  }
}
