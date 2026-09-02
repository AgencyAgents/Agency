import { describe, expect, test } from "bun:test";
import { AgencyError, ErrorCode } from "@agency/schema";
import { Scheduler } from "../src/scheduler.ts";

function rateLimited(): AgencyError {
  return new AgencyError(ErrorCode.RATE_LIMIT, "429", { source: "test" });
}

describe("Scheduler retry behavior", () => {
  test("retries a retryable error and succeeds once the failures stop", async () => {
    const scheduler = new Scheduler({ baseDelayMs: 5, maxDelayMs: 20, maxAttempts: 5 });
    let calls = 0;

    const result = await scheduler.schedule(async () => {
      calls += 1;
      if (calls < 3) throw rateLimited();
      return "ok";
    });

    expect(result).toBe("ok");
    expect(calls).toBe(3);
  });

  test("does not retry a fatal error at all", async () => {
    const scheduler = new Scheduler({ baseDelayMs: 5 });
    let calls = 0;

    const err = await scheduler
      .schedule(async () => {
        calls += 1;
        throw new AgencyError(ErrorCode.AUTH, "bad key", { source: "test" });
      })
      .catch((e) => e);

    expect(err).toBeInstanceOf(AgencyError);
    expect((err as AgencyError).code).toBe(ErrorCode.AUTH);
    expect(calls).toBe(1);
  });

  test("gives up and rethrows after maxAttempts retryable failures", async () => {
    const scheduler = new Scheduler({ baseDelayMs: 2, maxDelayMs: 5, maxAttempts: 3 });
    let calls = 0;

    const err = await scheduler
      .schedule(async () => {
        calls += 1;
        throw rateLimited();
      })
      .catch((e) => e);

    expect(calls).toBe(3);
    expect((err as AgencyError).code).toBe(ErrorCode.RATE_LIMIT);
  });

  test("honors a server-provided retryAfterMs instead of the computed backoff", async () => {
    const scheduler = new Scheduler({ baseDelayMs: 1000, maxAttempts: 2 });
    let calls = 0;
    const start = Date.now();

    await scheduler.schedule(async () => {
      calls += 1;
      if (calls === 1) {
        throw new AgencyError(ErrorCode.RATE_LIMIT, "429", {
          source: "test",
          context: { retryAfterMs: 10 },
        });
      }
      return "ok";
    });

    // The configured backoff base is 1s; honoring retryAfterMs should finish
    // in well under that instead of waiting out the full exponential delay.
    expect(Date.now() - start).toBeLessThan(500);
  });

  test("caps a hostile server-provided retryAfterMs at maxDelayMs", async () => {
    const scheduler = new Scheduler({ baseDelayMs: 1000, maxDelayMs: 50, maxAttempts: 2 });
    let calls = 0;
    const start = Date.now();

    await scheduler.schedule(async () => {
      calls += 1;
      if (calls === 1) {
        // "Retry after 24 hours" must not hang the turn for a day.
        throw new AgencyError(ErrorCode.RATE_LIMIT, "429", {
          source: "test",
          context: { retryAfterMs: 86_400_000 },
        });
      }
      return "ok";
    });

    expect(calls).toBe(2);
    expect(Date.now() - start).toBeLessThan(2000);
  });
});

describe("Scheduler concurrency", () => {
  test("never runs more than maxConcurrent tasks at once", async () => {
    const scheduler = new Scheduler({ maxConcurrent: 2, requestsPerMinute: 6000 });
    let inFlight = 0;
    let maxObserved = 0;

    const tasks = Array.from({ length: 8 }, () =>
      scheduler.schedule(async () => {
        inFlight += 1;
        maxObserved = Math.max(maxObserved, inFlight);
        await new Promise((r) => setTimeout(r, 15));
        inFlight -= 1;
        return "done";
      }),
    );

    await Promise.all(tasks);
    expect(maxObserved).toBeLessThanOrEqual(2);
  });

  test("runs queued tasks in FIFO order once slots free up", async () => {
    const scheduler = new Scheduler({ maxConcurrent: 1, requestsPerMinute: 6000 });
    const order: number[] = [];

    await Promise.all(
      [1, 2, 3].map((n) =>
        scheduler.schedule(async () => {
          order.push(n);
          await new Promise((r) => setTimeout(r, 5));
        }),
      ),
    );

    expect(order).toEqual([1, 2, 3]);
  });
});

describe("Scheduler rate limiting", () => {
  test("paces requests against requestsPerMinute once burst capacity is spent", async () => {
    // capacity ~= ceil(rpm/10); at rpm=600 that's 60 tokens of burst, so use a
    // tiny rpm so the burst is exhausted almost immediately and pacing kicks in.
    const scheduler = new Scheduler({ requestsPerMinute: 60, maxConcurrent: 10 });
    const start = Date.now();

    // Burst capacity is ceil(60/10) = 6, so the 7th request must wait for a refill.
    await Promise.all(Array.from({ length: 7 }, () => scheduler.schedule(async () => "x")));

    // 60 rpm = 1 token/sec; the 7th request needs to wait a meaningful amount.
    expect(Date.now() - start).toBeGreaterThan(50);
  });
});

describe("Scheduler per-call retry observer", () => {
  test("a per-call onRetry fires for that call's retries without touching the instance slot", async () => {
    const scheduler = new Scheduler({ baseDelayMs: 5, maxDelayMs: 10, maxAttempts: 3 });
    const observed: number[] = [];
    let calls = 0;

    const result = await scheduler.schedule(
      async () => {
        calls += 1;
        if (calls < 3) throw rateLimited();
        return "ok";
      },
      { onRetry: (attempt) => observed.push(attempt) },
    );

    expect(result).toBe("ok");
    expect(observed).toEqual([1, 2]);
    expect(scheduler.onRetry).toBeUndefined();
  });

  test("the instance onRetry still fires when no per-call observer is given", async () => {
    const scheduler = new Scheduler({ baseDelayMs: 5, maxDelayMs: 10, maxAttempts: 2 });
    const messages: string[] = [];
    scheduler.onRetry = (_attempt, message) => messages.push(message);

    await scheduler
      .schedule(async () => {
        throw rateLimited();
      })
      .catch(() => undefined);

    expect(messages).toEqual(["429"]);
  });

  test("concurrent calls with different observers each see only their own retries", async () => {
    const scheduler = new Scheduler({ baseDelayMs: 5, maxDelayMs: 10, maxAttempts: 3 });
    const seenBy: Record<string, number> = { a: 0, b: 0 };

    const failTimes = (times: number) => {
      let calls = 0;
      return async () => {
        calls += 1;
        if (calls < times) throw rateLimited();
        return "ok";
      };
    };

    await Promise.all([
      scheduler.schedule(failTimes(3), { onRetry: () => void seenBy.a++ }),
      scheduler.schedule(failTimes(2), { onRetry: () => void seenBy.b++ }),
    ]);

    expect(seenBy.a).toBe(2);
    expect(seenBy.b).toBe(1);
  });
});
