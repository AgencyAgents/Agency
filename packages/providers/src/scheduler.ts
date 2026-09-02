import { AgencyError } from "@agency/schema";

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
   * would overwrite or fire for another's retries — pass the observer here.
   */
  onRetry?: (attempt: number, message: string, next?: number) => void;
}

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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
