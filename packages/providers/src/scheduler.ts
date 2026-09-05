import { AgencyError, ErrorCode } from "@agency/schema";
import { getProviderMetadata } from "./registry.ts";

export interface SchedulerOptions {
  /** Requests allowed to run at once. */
  maxConcurrent?: number;
  /** Sustained request rate, refilled continuously (a token bucket, not a hard window). */
  requestsPerMinute?: number;
  /** Retries for a `retryable` AgencyError before giving up. */
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
}

export interface ScheduleOptions {
  /**
   * Per-call retry observer, fired before each backoff sleep for THIS call
   * only. The instance-level `onRetry` slot is process-global mutable state:
   * with two providers (or two concurrent turns) racing, one caller's observer
   * would overwrite or fire for another's retries - pass the observer here.
   */
  onRetry?: (attempt: number, message: string, next?: number) => void;
}

/** One key slot: a plain id, or an id with a priority (lower runs first). */
export type KeyRef = string | { readonly id: string; readonly priority?: number };

export interface RotationScheduleOptions extends ScheduleOptions {
  /** How long a key that fails retryably stays skipped. Defaults to 60s. */
  quarantineMs?: number;
}

/** Default quarantine for a key that fails with a retryable error. */
const DEFAULT_QUARANTINE_MS = 60_000;

/** Classic counting semaphore: bounds how many callers run at once, FIFO order. */
class Semaphore {
  private available: number;
  private readonly waiters: Array<() => void> = [];

  constructor(permits: number) {
    this.available = permits;
  }

  acquire(): Promise<void> {
    if (this.available > 0) {
      this.available -= 1;
      return Promise.resolve();
    }
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  release(): void {
    const next = this.waiters.shift();
    if (next) next();
    else this.available += 1;
  }
}

/** Continuous token bucket: refills gradually rather than resetting on a fixed window edge. */
class TokenBucket {
  private tokens: number;
  private lastRefill = Date.now();

  constructor(
    private readonly capacity: number,
    private readonly refillPerMs: number,
  ) {
    this.tokens = capacity;
  }

  async consume(): Promise<void> {
    while (true) {
      this.refill();
      if (this.tokens >= 1) {
        this.tokens -= 1;
        return;
      }
      await sleep(Math.max(1, Math.ceil((1 - this.tokens) / this.refillPerMs)));
    }
  }

  private refill(): void {
    const now = Date.now();
    this.tokens = Math.min(this.capacity, this.tokens + (now - this.lastRefill) * this.refillPerMs);
    this.lastRefill = now;
  }
}

/**
 * One scheduler per provider: caps concurrency, paces requests against a rate
 * limit, and retries transient failures with exponential backoff + jitter.
 * Sits behind every adapter call so none of them implement their own retry loop.
 */
export class Scheduler {
  private readonly semaphore: Semaphore;
  private readonly bucket: TokenBucket;
  private readonly maxAttempts: number;
  private readonly baseDelayMs: number;
  private readonly maxDelayMs: number;
  private rotationCursor = 0;
  private readonly quarantineUntil = new Map<string, number>();

  /** Optional retry observer: fired before each backoff sleep. `next` is the epoch ms the retry fires at. */
  onRetry?: (attempt: number, message: string, next?: number) => void;

  constructor(options: SchedulerOptions = {}) {
    this.semaphore = new Semaphore(options.maxConcurrent ?? 4);
    const rpm = options.requestsPerMinute ?? 60;
    const capacity = Math.max(1, Math.ceil(rpm / 10)); // ~6 seconds of burst headroom
    this.bucket = new TokenBucket(capacity, rpm / 60_000);
    this.maxAttempts = options.maxAttempts ?? 4;
    this.baseDelayMs = options.baseDelayMs ?? 500;
    this.maxDelayMs = options.maxDelayMs ?? 30_000;
  }

  /** Runs `fn` under the concurrency/rate limits, retrying retryable failures.
   *  The per-call observer in `options` wins over the instance's `onRetry`. */
  async schedule<T>(fn: () => Promise<T>, options?: ScheduleOptions): Promise<T> {
    await this.semaphore.acquire();
    try {
      await this.bucket.consume();
      return await this.runWithRetry(fn, options?.onRetry ?? this.onRetry?.bind(this));
    } finally {
      this.semaphore.release();
    }
  }

  /** Runs `fn` with one key at a time, rotating the start key per call.
   *  Retryable failures quarantine the key and fail over; anything else throws. */
  async scheduleWithKeys<T>(
    providerId: string,
    keys: readonly KeyRef[],
    fn: (keyId: string) => Promise<T>,
    options?: RotationScheduleOptions,
  ): Promise<T> {
    getProviderMetadata(providerId);
    const order = normalizeKeyOrder(keys);
    if (order.length === 0) {
      throw new AgencyError(ErrorCode.INTERNAL, "scheduleWithKeys needs at least one key", {
        source: "scheduler",
      });
    }
    // Claimed synchronously (before any await) so concurrent calls start on
    // different keys, mirroring the single-flight claim in auth/oauth.ts.
    const start = this.rotationCursor % order.length;
    this.rotationCursor += 1;
    const quarantineMs = options?.quarantineMs ?? DEFAULT_QUARANTINE_MS;
    const onRetry = options?.onRetry ?? this.onRetry?.bind(this);

    await this.semaphore.acquire();
    try {
      await this.bucket.consume();
      return await this.runWithRotation(order, start, quarantineMs, fn, onRetry);
    } finally {
      this.semaphore.release();
    }
  }

  /** Quarantined key ids whose expiry is still in the future. */
  getQuarantinedKeys(): string[] {
    this.pruneQuarantine(Date.now());
    return [...this.quarantineUntil.keys()];
  }

  /** Drops all quarantine state, mainly for tests. */
  clearQuarantine(): void {
    this.quarantineUntil.clear();
  }

  private pruneQuarantine(now: number): void {
    for (const [key, until] of this.quarantineUntil) {
      if (until <= now) this.quarantineUntil.delete(key);
    }
  }

  private async runWithRotation<T>(
    order: readonly string[],
    start: number,
    quarantineMs: number,
    fn: (keyId: string) => Promise<T>,
    onRetry: ScheduleOptions["onRetry"],
  ): Promise<T> {
    let attempts = 0;
    let nextIndex = start;
    while (true) {
      const now = Date.now();
      this.pruneQuarantine(now);
      let keyIndex = -1;
      for (let i = 0; i < order.length; i += 1) {
        const candidate = order[(nextIndex + i) % order.length] as string;
        if (!this.quarantineUntil.has(candidate)) {
          keyIndex = (nextIndex + i) % order.length;
          break;
        }
      }
      if (keyIndex === -1) {
        const earliest = Math.min(...this.quarantineUntil.values());
        const waitMs = Math.max(0, Math.min(this.backoffDelay(attempts + 1), earliest - Date.now()));
        onRetry?.(attempts + 1, "all keys quarantined", Date.now() + waitMs);
        await sleep(waitMs);
        continue;
      }
      const keyId = order[keyIndex] as string;
      nextIndex = (keyIndex + 1) % order.length;
      try {
        return await fn(keyId);
      } catch (error) {
        const retryable = error instanceof AgencyError && error.retryClass === "retryable";
        if (!retryable) throw error;
        attempts += 1;
        this.quarantineUntil.set(keyId, Date.now() + quarantineMs);
        if (attempts >= this.maxAttempts) throw error;
        const retryAfterMs = extractRetryAfterMs(error);
        const delayMs =
          retryAfterMs !== undefined
            ? Math.min(Math.max(retryAfterMs, 0), this.maxDelayMs)
            : this.backoffDelay(attempts);
        onRetry?.(attempts, error.message, retryAfterMs !== undefined ? Date.now() + delayMs : undefined);
        await sleep(delayMs);
      }
    }
  }

  private async runWithRetry<T>(fn: () => Promise<T>, onRetry: ScheduleOptions["onRetry"]): Promise<T> {
    let attempt = 0;
    while (true) {
      attempt += 1;
      try {
        return await fn();
      } catch (error) {
        const shouldRetry =
          error instanceof AgencyError && error.retryClass === "retryable" && attempt < this.maxAttempts;
        if (!shouldRetry) throw error;

        const retryAfterMs = error instanceof AgencyError ? extractRetryAfterMs(error) : undefined;
        // Security bound: a hostile or misconfigured Retry-After must not hang a
        // turn for a day, so the header is capped like the computed backoff is.
        const delayMs =
          retryAfterMs !== undefined
            ? Math.min(Math.max(retryAfterMs, 0), this.maxDelayMs)
            : this.backoffDelay(attempt);
        onRetry?.(attempt, error.message, retryAfterMs !== undefined ? Date.now() + delayMs : undefined);
        await sleep(delayMs);
      }
    }
  }

  private backoffDelay(attempt: number): number {
    const exponential = Math.min(this.baseDelayMs * 2 ** (attempt - 1), this.maxDelayMs);
    return exponential * (0.5 + Math.random() * 0.5); // full jitter within the top half
  }
}

function extractRetryAfterMs(error: AgencyError): number | undefined {
  const value = error.context.retryAfterMs;
  return typeof value === "number" ? value : undefined;
}

/** Caller order, stable sorted by priority (lower first); plain ids keep priority 0. */
function normalizeKeyOrder(keys: readonly KeyRef[]): string[] {
  return keys
    .map((key, index) => ({
      id: typeof key === "string" ? key : key.id,
      priority: typeof key === "string" ? 0 : (key.priority ?? 0),
      index,
    }))
    .sort((a, b) => a.priority - b.priority || a.index - b.index)
    .map((entry) => entry.id);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
