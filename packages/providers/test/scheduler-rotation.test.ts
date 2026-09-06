import { describe, expect, test } from "bun:test";
import { AgencyError, ErrorCode } from "@agency/schema";
import { UnknownProviderError } from "../src/registry.ts";
import { Scheduler } from "../src/scheduler.ts";

function retryable(msg = "429"): AgencyError {
  return new AgencyError(ErrorCode.RATE_LIMIT, msg, { source: "test" });
}

function authError(): AgencyError {
  return new AgencyError(ErrorCode.AUTH, "bad key", { source: "test" });
}

function fatalError(): AgencyError {
  return new AgencyError(ErrorCode.INTERNAL, "boom", { source: "test" });
}

describe("Scheduler rotation order round robins start key across calls", () => {
  test("successive calls start on successive keys", async () => {
    const scheduler = new Scheduler({ baseDelayMs: 5, maxDelayMs: 10, requestsPerMinute: 6000 });
    const seen: string[] = [];
    for (let i = 0; i < 3; i++) {
      await scheduler.scheduleWithKeys("openai", ["k1", "k2", "k3"], async (key) => {
        seen.push(key);
        return key;
      });
    }
    expect(seen).toEqual(["k1", "k2", "k3"]);
  });
});

describe("Scheduler rotation priority order tries lowest priority first", () => {
  test("priority 0 beats priority 5 regardless of input order", async () => {
    const scheduler = new Scheduler({ baseDelayMs: 5, maxDelayMs: 10, requestsPerMinute: 6000 });
    const seen: string[] = [];
    await scheduler.scheduleWithKeys(
      "openai",
      [
        { id: "low", priority: 5 },
        { id: "high", priority: 0 },
      ],
      async (key) => {
        seen.push(key);
        return key;
      },
    );
    expect(seen).toEqual(["high"]);
  });
});

describe("Scheduler failover on retryable tries next key", () => {
  test("retryable error fails over to next key and succeeds", async () => {
    const scheduler = new Scheduler({
      baseDelayMs: 5,
      maxDelayMs: 10,
      maxAttempts: 4,
      requestsPerMinute: 6000,
    });
    const seen: string[] = [];
    const result = await scheduler.scheduleWithKeys("openai", ["k1", "k2"], async (key) => {
      seen.push(key);
      if (key === "k1") throw retryable();
      return "ok";
    });
    expect(result).toBe("ok");
    expect(seen).toEqual(["k1", "k2"]);
  });
});

describe("Scheduler never fails over on auth errors", () => {
  test("auth error throws after one call with no quarantine", async () => {
    const scheduler = new Scheduler({
      baseDelayMs: 5,
      maxDelayMs: 10,
      maxAttempts: 4,
      requestsPerMinute: 6000,
    });
    const seen: string[] = [];
    const err = await scheduler
      .scheduleWithKeys("openai", ["k1", "k2"], async (key) => {
        seen.push(key);
        throw authError();
      })
      .catch((e) => e);
    expect(err).toBeInstanceOf(AgencyError);
    expect((err as AgencyError).code).toBe(ErrorCode.AUTH);
    expect(seen).toEqual(["k1"]);
    expect(scheduler.getQuarantinedKeys()).toEqual([]);
  });
});

describe("Scheduler never fails over on non retryable fatal errors", () => {
  test("fatal error throws after one call", async () => {
    const scheduler = new Scheduler({
      baseDelayMs: 5,
      maxDelayMs: 10,
      maxAttempts: 4,
      requestsPerMinute: 6000,
    });
    const seen: string[] = [];
    const err = await scheduler
      .scheduleWithKeys("openai", ["k1", "k2"], async (key) => {
        seen.push(key);
        throw fatalError();
      })
      .catch((e) => e);
    expect((err as AgencyError).code).toBe(ErrorCode.INTERNAL);
    expect(seen).toEqual(["k1"]);
  });
});

describe("Scheduler quarantine skips unhealthy keys then expires", () => {
  test("quarantined key is skipped on next call and reused after expiry", async () => {
    const scheduler = new Scheduler({
      baseDelayMs: 5,
      maxDelayMs: 10,
      maxAttempts: 4,
      requestsPerMinute: 6000,
    });
    const firstSeen: string[] = [];
    await scheduler.scheduleWithKeys(
      "openai",
      ["k1", "k2"],
      async (key) => {
        firstSeen.push(key);
        if (key === "k1") throw retryable();
        return "ok";
      },
      { quarantineMs: 60_000 },
    );
    expect(firstSeen).toEqual(["k1", "k2"]);
    expect(scheduler.getQuarantinedKeys()).toEqual(["k1"]);

    const secondSeen: string[] = [];
    await scheduler.scheduleWithKeys(
      "openai",
      ["k1", "k2"],
      async (key) => {
        secondSeen.push(key);
        return "ok";
      },
      { quarantineMs: 60_000 },
    );
    expect(secondSeen).toEqual(["k2"]);

    const shortScheduler = new Scheduler({
      baseDelayMs: 5,
      maxDelayMs: 10,
      maxAttempts: 4,
      requestsPerMinute: 6000,
    });
    const order: string[] = [];
    await shortScheduler.scheduleWithKeys(
      "openai",
      ["k1", "k2"],
      async (key) => {
        order.push(key);
        if (key === "k1") throw retryable();
        return "ok";
      },
      { quarantineMs: 15 },
    );
    await new Promise((r) => setTimeout(r, 30));
    const after: string[] = [];
    await shortScheduler.scheduleWithKeys("openai", ["k1", "k2"], async (key) => {
      after.push(key);
      return "ok";
    });
    expect(after.length).toBe(1);
    expect(order[0]).toBe("k1");
  });
});

describe("Scheduler rotation respects backoff caps", () => {
  test("hostile retryAfterMs is capped at maxDelayMs across keys", async () => {
    const scheduler = new Scheduler({
      baseDelayMs: 5,
      maxDelayMs: 30,
      maxAttempts: 2,
      requestsPerMinute: 6000,
    });
    let calls = 0;
    const start = Date.now();
    const err = await scheduler
      .scheduleWithKeys("openai", ["k1", "k2"], async () => {
        calls += 1;
        throw new AgencyError(ErrorCode.RATE_LIMIT, "429", {
          source: "test",
          context: { retryAfterMs: 86_400_000 },
        });
      })
      .catch((e) => e);
    expect((err as AgencyError).code).toBe(ErrorCode.RATE_LIMIT);
    expect(calls).toBe(2);
    expect(Date.now() - start).toBeLessThan(5000);
  });

  test("total key attempts never exceed maxAttempts", async () => {
    const scheduler = new Scheduler({
      baseDelayMs: 2,
      maxDelayMs: 5,
      maxAttempts: 3,
      requestsPerMinute: 6000,
    });
    let calls = 0;
    await scheduler
      .scheduleWithKeys("openai", ["k1", "k2", "k3"], async () => {
        calls += 1;
        throw retryable();
      })
      .catch(() => undefined);
    expect(calls).toBe(3);
  });

  test("a 5-key pool with maxAttempts 4 still tries every key", async () => {
    const scheduler = new Scheduler({
      baseDelayMs: 2,
      maxDelayMs: 5,
      maxAttempts: 4,
      requestsPerMinute: 6000,
    });
    const seen: string[] = [];
    await scheduler
      .scheduleWithKeys("openai", ["k1", "k2", "k3", "k4", "k5"], async (key) => {
        seen.push(key);
        throw retryable();
      })
      .catch(() => undefined);
    expect(seen).toEqual(["k1", "k2", "k3", "k4", "k5"]);
  });
});

describe("Scheduler rotation rejects unknown providers", () => {
  test("unknown provider id throws UnknownProviderError", async () => {
    const scheduler = new Scheduler({ requestsPerMinute: 6000 });
    const err = await scheduler.scheduleWithKeys("nope", ["k1"], async () => "x").catch((e) => e);
    expect(err).toBeInstanceOf(UnknownProviderError);
  });
});

describe("Scheduler concurrent rotation starts on different keys", () => {
  test("two concurrent calls claim different start keys", async () => {
    const scheduler = new Scheduler({
      maxConcurrent: 2,
      requestsPerMinute: 6000,
      baseDelayMs: 5,
      maxDelayMs: 10,
    });
    const starts = await Promise.all(
      [0, 1].map(() =>
        scheduler.scheduleWithKeys("openai", ["k1", "k2"], async (key) => {
          await new Promise((r) => setTimeout(r, 10));
          return key;
        }),
      ),
    );
    expect([...starts].sort()).toEqual(["k1", "k2"]);
  });
});
