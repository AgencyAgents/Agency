import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { loadCassettes } from "../src/cassette.ts";
import { noFetchHttp, replayTask, replayTaskViaChildTurn } from "../src/replay.ts";

const dir = join(import.meta.dir, "..", "cassettes");

describe("eval offline replay", () => {
  test("replay makes zero provider calls on the loop path", async () => {
    let calls = 0;
    const http = noFetchHttp(() => {
      calls += 1;
    });
    for (const cassette of loadCassettes(dir)) {
      for (const task of cassette.tasks) {
        const result = await replayTask(http, task);
        expect(result.usage).toEqual(task.usage);
      }
    }
    expect(calls).toBe(0);
  });

  test("replay makes zero provider calls on the child-turn path", async () => {
    let calls = 0;
    const http = noFetchHttp(() => {
      calls += 1;
    });
    for (const cassette of loadCassettes(dir)) {
      for (const task of cassette.tasks) {
        const outcome = await replayTaskViaChildTurn(http, cassette, task);
        expect(outcome.error).toBeUndefined();
        expect(outcome.result?.usage).toEqual(task.usage);
      }
    }
    expect(calls).toBe(0);
  });

  test("every report column is present for every roster", async () => {
    const { scoreReport } = await import("../src/scoring.ts");
    const { serializeReport } = await import("../src/report.ts");
    const report = scoreReport(loadCassettes(dir));
    const parsed = JSON.parse(serializeReport(report)) as {
      scores: Record<string, unknown>[];
      promptVersion: string;
      pending: { roster: string }[];
    };
    expect(parsed.promptVersion).toBe("1.0.0");
    expect(parsed.scores).toHaveLength(5);
    for (const s of parsed.scores) {
      for (const key of [
        "roster",
        "passRate",
        "costPerCompleted",
        "totalUsd",
        "inputTokens",
        "cacheHitRate",
        "conflicts",
        "wallClockMs",
        "promptVersion",
      ]) {
        expect(s).toHaveProperty(key);
      }
    }
    expect(parsed.pending).toEqual([]);
  });
});
