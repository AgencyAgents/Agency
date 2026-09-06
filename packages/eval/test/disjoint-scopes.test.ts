import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { scopeMatchesPattern } from "@agency/guard";
import { loadCassettes } from "../src/cassette.ts";
import { scoreReport } from "../src/scoring.ts";

const dir = join(import.meta.dir, "..", "cassettes");

function overlaps(a: readonly string[], b: readonly string[]): boolean {
  return a.some((x) => b.includes(x));
}

describe("phase 6 disjoint scopes on the conflicting task", () => {
  test("baseline multi-1 carries the N-writer conflict", () => {
    const report = scoreReport(loadCassettes(dir));
    const team = report.scores.find((s) => s.roster === "team");
    expect(team?.conflicts).toBeGreaterThan(0);
  });

  test("disjoint path scopes partition multi-1 writes with zero conflicts", () => {
    const cassettes = loadCassettes(dir);
    const team = cassettes.find((c) => c.roster === "team");
    if (!team) throw new Error("team cassette required");
    const multi = team.tasks.find((t) => t.kind === "multi");
    if (!multi) throw new Error("team cassette needs a multi-file task");
    const scopes = ["src/auth/**", "src/db/**"];
    const partitions = scopes.map((scope) => multi.filesTouched.filter((f) => scopeMatchesPattern(scope, f)));
    expect(partitions.flat().sort()).toEqual([...multi.filesTouched].sort());
    let conflicts = 0;
    for (let i = 0; i < partitions.length; i++) {
      for (let j = i + 1; j < partitions.length; j++) {
        if (overlaps(partitions[i] ?? [], partitions[j] ?? [])) conflicts += 1;
      }
    }
    expect(conflicts).toBe(0);
  });
});
