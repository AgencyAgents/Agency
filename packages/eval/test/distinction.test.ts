import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { loadCassettes } from "../src/cassette.ts";
import { scoreReport } from "../src/scoring.ts";

const dir = join(import.meta.dir, "..", "cassettes");

describe("eval solo versus team", () => {
  test("configurations differ on the multi-file task", () => {
    const cassettes = loadCassettes(dir);
    const solo = cassettes.find((c) => c.roster === "solo");
    const team = cassettes.find((c) => c.roster === "team");
    if (!solo || !team) throw new Error("solo and team cassettes required");
    const soloMulti = solo.tasks.find((t) => t.kind === "multi");
    const teamMulti = team.tasks.find((t) => t.kind === "multi");
    if (!soloMulti || !teamMulti) throw new Error("both cassettes need a multi-file task");
    expect(soloMulti.taskId).toBe(teamMulti.taskId);
    expect(teamMulti.passed).toBe(true);
    expect(soloMulti.passed).toBe(false);
    const report = scoreReport([solo, team]);
    expect(report.scores[0]?.passRate).not.toBe(report.scores[1]?.passRate);
  });

  test("team baseline records the N-writer conflict the solo run avoids", () => {
    const report = scoreReport(loadCassettes(dir));
    const solo = report.scores.find((s) => s.roster === "solo");
    const team = report.scores.find((s) => s.roster === "team");
    expect(solo?.conflicts).toBe(0);
    expect(team?.conflicts).toBeGreaterThan(0);
  });
});
