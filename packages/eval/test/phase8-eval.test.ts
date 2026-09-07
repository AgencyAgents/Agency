import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { loadCassettes } from "../src/cassette.ts";
import { BASELINE_ROSTERS, resolveRoster } from "../src/rosters.ts";
import { scoreReport } from "../src/scoring.ts";

const dir = join(import.meta.dir, "..", "cassettes");

describe("phase 8 eval comparisons", () => {
  test("reviewer-first beats solo and matches team on pass-rate with zero conflicts", () => {
    const report = scoreReport(loadCassettes(dir));
    const solo = report.scores.find((s) => s.roster === "solo");
    const team = report.scores.find((s) => s.roster === "team");
    const rf = report.scores.find((s) => s.roster === "reviewer-first");
    expect(solo?.passRate).toBeCloseTo(0.8333, 4);
    expect(rf?.passRate).toBeGreaterThan(solo?.passRate ?? 0);
    expect(rf?.passRate).toBeGreaterThanOrEqual(team?.passRate ?? 0);
    expect(rf?.conflicts).toBe(0);
    expect(team?.conflicts).toBeGreaterThan(0);
    expect(rf?.costPerCompleted).toBeLessThan(team?.costPerCompleted ?? Number.MAX_VALUE);
  });

  test("the model ladder beats fixed per-role routing on cost per completed task", () => {
    const report = scoreReport(loadCassettes(dir));
    const fixed = report.scores.find((s) => s.roster === "fixed");
    const ladder = report.scores.find((s) => s.roster === "ladder");
    expect(fixed?.passRate).toBe(ladder?.passRate);
    expect(ladder?.costPerCompleted).toBeLessThan(fixed?.costPerCompleted ?? Number.MAX_VALUE);
  });

  test("all five rosters execute with no pending configurations", () => {
    expect(BASELINE_ROSTERS).toEqual(["solo", "team", "reviewer-first", "fixed", "ladder"]);
    for (const id of BASELINE_ROSTERS) expect(resolveRoster(id).executes).toBe(true);
    const report = scoreReport(loadCassettes(dir));
    expect(report.scores).toHaveLength(5);
    expect(report.pending).toEqual([]);
  });
});
