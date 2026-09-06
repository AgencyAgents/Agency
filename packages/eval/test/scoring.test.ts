import { describe, expect, test } from "bun:test";
import { scoreCassette } from "../src/scoring.ts";
import type { EvalCassette, EvalTaskRecord } from "../src/types.ts";

const pricing = { inputPerMTok: 3, outputPerMTok: 15, cachedInputPerMTok: 0.3 };

function task(over: Partial<EvalTaskRecord> & { taskId: string }): EvalTaskRecord {
  return {
    kind: "single",
    filesTouched: ["src/a.ts"],
    passed: true,
    usage: { inputTokens: 1000, outputTokens: 100 },
    wallClockMs: 1000,
    conflicts: 0,
    ...over,
  };
}

function cassette(tasks: EvalTaskRecord[]): EvalCassette {
  return { version: 1, roster: "solo", promptVersion: "1.0.0", pricing, tasks };
}

describe("eval scoring", () => {
  test("zero completions yields null cost per task and zero pass rate", () => {
    const score = scoreCassette(
      cassette([task({ taskId: "t1", passed: false }), task({ taskId: "t2", passed: false })]),
    );
    expect(score.completed).toBe(0);
    expect(score.passRate).toBe(0);
    expect(score.costPerCompleted).toBeNull();
    expect(score.totalUsd).toBeGreaterThan(0);
  });

  test("empty task list scores zero without dividing", () => {
    const score = scoreCassette(cassette([]));
    expect(score.passRate).toBe(0);
    expect(score.costPerCompleted).toBeNull();
    expect(score.cacheHitRate).toBeNull();
  });

  test("partial credit lifts pass rate but not the completed count", () => {
    const score = scoreCassette(
      cassette([
        task({ taskId: "t1", passed: true }),
        task({ taskId: "t2", passed: false, partialCredit: 0.5 }),
      ]),
    );
    expect(score.passRate).toBe(0.75);
    expect(score.completed).toBe(1);
    expect(score.costPerCompleted).toBe(score.totalUsd);
  });

  test("cache-hit rate divides cached by total input", () => {
    const score = scoreCassette(
      cassette([
        task({ taskId: "t1", usage: { inputTokens: 1000, outputTokens: 0, cachedInputTokens: 250 } }),
        task({ taskId: "t2", usage: { inputTokens: 3000, outputTokens: 0, cachedInputTokens: 750 } }),
      ]),
    );
    expect(score.cacheHitRate).toBe(0.25);
  });

  test("no cache data reports null hit rate instead of zero", () => {
    const score = scoreCassette(
      cassette([task({ taskId: "t1", usage: { inputTokens: 1000, outputTokens: 10 } })]),
    );
    expect(score.cacheHitRate).toBeNull();
  });

  test("cached tokens bill at the cache premium, not the input rate", () => {
    const score = scoreCassette(
      cassette([
        task({
          taskId: "t1",
          usage: { inputTokens: 1_000_000, outputTokens: 0, cachedInputTokens: 500_000 },
        }),
      ]),
    );
    expect(score.totalUsd).toBeCloseTo(1.65, 10);
  });

  test("conflicts and wall clock sum across tasks", () => {
    const score = scoreCassette(
      cassette([
        task({ taskId: "t1", conflicts: 2, wallClockMs: 3000 }),
        task({ taskId: "t2", conflicts: 1, wallClockMs: 7000 }),
      ]),
    );
    expect(score.conflicts).toBe(3);
    expect(score.wallClockMs).toBe(10000);
  });
});
