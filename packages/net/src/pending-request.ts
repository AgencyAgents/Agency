/**
 * Single source of truth for the request/response bookkeeping every
 * message-oriented client needs (MCP, LSP, daemon RPC): hand out a unique
 * ID, park a promise keyed by it, bound the wait with a timeout, and clean
 * up on every exit path — response, error, timeout, or transport death.
 * The pattern drifted independently in three clients before this lived here.
 */
export interface PendingRequestManagerOptions<ID extends string | number> {
  /**
   * Produces unique request IDs. Use `counterIds()` for JSON-RPC-style
   * numeric IDs; a UUID factory for protocols whose IDs are opaque strings.
   */
  makeId: () => ID;
}

/** Numeric request IDs incrementing from `start` (default 1). */
export function counterIds(start = 1): () => number {
  let next = start;
  return () => next++;
}

interface PendingEntry {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class PendingRequestManager<ID extends string | number = number> {
  private readonly pending = new Map<ID, PendingEntry>();
  private readonly makeId: () => ID;

  constructor(options: PendingRequestManagerOptions<ID>) {
    this.makeId = options.makeId;
  }

  /** How many requests are awaiting a response. */
  get size(): number {
    return this.pending.size;
  }

  /** Whether a request with this ID is still awaiting a response. */
  has(id: ID): boolean {
    return this.pending.has(id);
  }

  /**
   * Registers a request and starts its timeout. The entry exists before this
   * returns, so the caller can send the request immediately after and any
   * response that arrives resolves the returned promise.
   *
   * `makeTimeoutError` stays with the caller because the message is
   * protocol-specific (and may be localized); the manager only owns the
   * timing and cleanup.
   */
  register(timeoutMs: number, makeTimeoutError: () => Error): { id: ID; promise: Promise<unknown> } {
    const id = this.makeId();
    const promise = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(makeTimeoutError());
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
    });
    return { id, promise };
  }

  /** Resolves the request with a result. Returns false when nothing is pending. */
  resolve(id: ID, value: unknown): boolean {
    const entry = this.pending.get(id);
    if (!entry) return false;
    this.pending.delete(id);
    clearTimeout(entry.timer);
    entry.resolve(value);
    return true;
  }

  /** Rejects the request with an error. Returns false when nothing is pending. */
  reject(id: ID, error: Error): boolean {
    const entry = this.pending.get(id);
    if (!entry) return false;
    this.pending.delete(id);
    clearTimeout(entry.timer);
    entry.reject(error);
    return true;
  }

  /** Rejects and clears every pending request (transport died or closed). */
  failAll(error: Error): void {
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    this.pending.clear();
  }
}
