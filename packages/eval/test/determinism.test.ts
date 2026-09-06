import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadCassettes } from "../src/cassette.ts";
import { noFetchHttp, replayTask } from "../src/replay.ts";
import { serializeReport } from "../src/report.ts";
import { scoreReport } from "../src/scoring.ts";

const dir = join(import.meta.dir, "..", "cassettes");

describe("eval determinism", () => {
  test("two consecutive runs emit byte-identical score files", () => {
    const first = serializeReport(scoreReport(loadCassettes(dir)));
    const second = serializeReport(scoreReport(loadCassettes(dir)));
    expect(second).toBe(first);
  });

  test("replaying one cassette twice yields identical messages", async () => {
    const http = noFetchHttp();
    const task = loadCassettes(dir)[0]?.tasks[0];
    if (!task) throw new Error("solo cassette needs a first task");
    const a = await replayTask(http, task);
    const b = await replayTask(http, task);
    expect(JSON.stringify(b.messages)).toBe(JSON.stringify(a.messages));
    expect(b.usage).toEqual(a.usage);
  });

  test("committed baseline matches a fresh score of the cassettes", () => {
    const fresh = serializeReport(scoreReport(loadCassettes(dir)));
    const committed = readFileSync(join(import.meta.dir, "..", "report", "baseline.json"), "utf8");
    expect(committed).toBe(fresh);
  });

  test("cassettes carry no timestamps, absolute paths, or randomness", () => {
    for (const name of ["solo.json", "team.json"]) {
      const raw = readFileSync(join(dir, name), "utf8");
      expect(raw).not.toContain("createdAt");
      expect(raw).not.toContain("timestamp");
      expect(raw).not.toMatch(/[A-Z]:\\/);
      expect(raw).not.toMatch(/"\/(users|tmp|home)\//i);
    }
  });
});
