import { describe, expect, test } from "bun:test";
import { turnCostUsd } from "@agency/telemetry";
import { renderReport } from "../src/report.ts";
import { scoreCassette, scoreReport } from "../src/scoring.ts";
import type { EvalCassette } from "../src/types.ts";

const pricing = {
  inputPerMTok: 3,
  outputPerMTok: 15,
  cachedInputPerMTok: 0.3,
  cacheWritePerMTok: 3.75,
};

function cassette(): EvalCassette {
  return {
    version: 1,
    roster: "ladder",
    promptVersion: "1.0.0",
    pricing,
    tasks: [
      {
        taskId: "t1",
        kind: "single",
        filesTouched: ["src/a.ts"],
        passed: true,
        usage: { inputTokens: 100_000, outputTokens: 1_000, cachedInputTokens: 60_000 },
        wallClockMs: 1000,
        conflicts: 0,
      },
      {
        taskId: "t2",
        kind: "multi",
        filesTouched: ["src/b.ts"],
        passed: true,
        usage: { inputTokens: 100_000, outputTokens: 1_000, cacheWriteInputTokens: 60_000 },
        wallClockMs: 2000,
        conflicts: 0,
      },
    ],
  };
}

describe("phase 9 eval cost accounting", () => {
  test("the eval report consumes the same accounting path as the RPC cost report", () => {
    const input = cassette();
    const score = scoreCassette(input);
    const expected = input.tasks.reduce((sum, task) => sum + turnCostUsd(task.usage, input.pricing), 0);
    expect(score.totalUsd).toBe(expected);
  });

  test("a cached read and an uncached write on the same tokens score differently", () => {
    const score = scoreCassette(cassette());
    const read = turnCostUsd(cassette().tasks[0]!.usage, pricing);
    const write = turnCostUsd(cassette().tasks[1]!.usage, pricing);
    expect(write).toBeGreaterThan(read);
    expect(score.totalUsd).toBe(read + write);
  });

  test("cache-hit rate is a first-class report column", () => {
    const report = scoreReport([cassette()]);
    expect(report.scores[0]?.cacheHitRate).toBeCloseTo(0.3, 9);
    const rendered = renderReport(report);
    expect(rendered).toContain("hit");
    expect(rendered).toContain("30%");
  });
});
