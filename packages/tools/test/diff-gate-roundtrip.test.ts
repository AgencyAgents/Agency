import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  addDiffComment,
  approveDiffWithComments,
  evaluateDiffGate,
  formatDiffGateForDisplay,
  listDiffComments,
  resolveDiffComment,
} from "../src/diff-review.ts";

const dirs: string[] = [];

function target(): string {
  const dir = mkdtempSync(join(tmpdir(), "agency-diff-gate-test-"));
  dirs.push(dir);
  return join(dir, "change.diff");
}

function cleanup(): void {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
}

describe("diff comment roundtrip gate", () => {
  test("clean target passes and formats as passed", () => {
    const t = target();
    try {
      const decision = evaluateDiffGate(t);
      expect(decision.pass).toBe(true);
      expect(decision.reason).toBe("pass-clean");
      expect(formatDiffGateForDisplay(decision)).toContain("pass-clean");
      const record = approveDiffWithComments("change-1", "- old\n+ new\n", t);
      expect(record.id).toBe("change-1");
      expect(typeof record.hash).toBe("string");
    } finally {
      cleanup();
    }
  });

  test("add blocks approval, resolve unblocks it", () => {
    const t = target();
    try {
      const c1 = addDiffComment(t, { text: "fix this line", line: 2 });
      expect(listDiffComments(t)).toHaveLength(1);
      const blocked = evaluateDiffGate(t);
      expect(blocked.pass).toBe(false);
      expect(blocked.reason).toBe("fail-unresolved-comments");
      expect(blocked.unresolved).toBe(1);
      expect(formatDiffGateForDisplay(blocked)).toContain("fail-unresolved-comments");
      expect(() => approveDiffWithComments("change-1", "- old\n+ new\n", t)).toThrow(/unresolved/);
      expect(resolveDiffComment(t, c1.id)).toBe(true);
      const open = evaluateDiffGate(t);
      expect(open.pass).toBe(true);
      expect(open.reason).toBe("pass-clean");
      expect(approveDiffWithComments("change-1", "- old\n+ new\n", t).id).toBe("change-1");
    } finally {
      cleanup();
    }
  });
});
