import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  addDiffComment,
  countUnresolvedComments,
  createDiffApproval,
  listDiffComments,
  MAX_DIFF_BYTES,
  MAX_DIFF_LINES,
  renderSideBySide,
  resolveDiffComment,
} from "../src/diff-review.ts";

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "agency-diff-review-test-"));
  process.on("exit", () => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

describe("renderSideBySide", () => {
  test("identical texts render as empty (unifiedDiff convention)", () => {
    expect(renderSideBySide("a\nb\n", "a\nb\n")).toBe("");
  });

  test("changed lines carry old/new numbers and -/+ markers", () => {
    const out = renderSideBySide("line1\nline2\nline3\n", "line1\nline2 changed\nline3\n");
    expect(out).toContain("--- a/file");
    expect(out).toContain("+++ b/file");
    expect(out).toContain("- line2");
    expect(out).toContain("+ line2 changed");
    expect(out).toMatch(/@@ -1,3 \+1,3 @@/);
  });

  test("context lines show both numbers, deletions blank the new side", () => {
    const out = renderSideBySide("keep\nbye\n", "keep\n");
    expect(out).toMatch(/1\s+1 \|/);
    expect(out).toContain("- bye");
  });

  test("honors custom file labels and context", () => {
    const out = renderSideBySide("a\nb\nc\nd\n", "a\nB\nc\nd\n", {
      oldPath: "a/old.ts",
      newPath: "b/new.ts",
      context: 1,
    });
    expect(out).toContain("--- a/old.ts");
    expect(out).toContain("+++ b/new.ts");
  });

  test("caps bodies at 200 lines with a notice", () => {
    const before = Array.from({ length: 500 }, (_, i) => `line ${i}`).join("\n");
    const after = Array.from({ length: 500 }, (_, i) => `changed ${i}`).join("\n");
    const out = renderSideBySide(before, after, { context: 0 });
    const bodyLines = out
      .split("\n")
      .filter(
        (l) =>
          l.length > 0 &&
          !l.startsWith("---") &&
          !l.startsWith("+++") &&
          !l.startsWith("@@") &&
          !l.startsWith("..."),
      );
    expect(bodyLines.length).toBeLessThanOrEqual(MAX_DIFF_LINES);
    expect(out).toContain("200-line cap");
  });

  test("caps output at 30K bytes with a notice", () => {
    const longLine = `x${"y".repeat(500)}`;
    const before = Array.from({ length: 60 }, () => longLine).join("\n");
    const after = Array.from({ length: 60 }, () => `${longLine}z`).join("\n");
    const out = renderSideBySide(before, after, { context: 0 });
    expect(Buffer.byteLength(out, "utf8")).toBeLessThanOrEqual(MAX_DIFF_BYTES + 200);
    expect(out).toContain(`${MAX_DIFF_BYTES} bytes`);
  });
});

describe("diff comments", () => {
  test("add/list/resolve round-trips through the plan .comments.json stub", () => {
    const dir = tempDir();
    const target = join(dir, "change.diff");
    expect(countUnresolvedComments(target)).toBe(0);
    const c1 = addDiffComment(target, { text: "looks good?", line: 3 });
    expect(c1.resolved).toBe(false);
    expect(c1.line).toBe(3);
    addDiffComment(target, { text: "second thought" });
    expect(countUnresolvedComments(target)).toBe(2);
    expect(listDiffComments(target).length).toBe(2);
    expect(resolveDiffComment(target, c1.id)).toBe(true);
    expect(countUnresolvedComments(target)).toBe(1);
    expect(resolveDiffComment(target, "missing-id")).toBe(false);
  });

  test("rejects empty text and bad line numbers", () => {
    const dir = tempDir();
    const target = join(dir, "other.diff");
    expect(() => addDiffComment(target, { text: "   " })).toThrow(/non-empty text/);
    expect(() => addDiffComment(target, { text: "x", line: 0 })).toThrow(/positive integer/);
    expect(countUnresolvedComments(target)).toBe(0);
  });
});

describe("createDiffApproval", () => {
  test("records the sha256 of the exact approved diff", async () => {
    const { createHash } = await import("node:crypto");
    const diff = "- old\n+ new\n";
    const record = createDiffApproval("change-1", diff, "reviewer");
    expect(record.id).toBe("change-1");
    expect(record.hash).toBe(createHash("sha256").update(diff, "utf8").digest("hex"));
    expect(record.approvedBy).toBe("reviewer");
    expect(typeof record.approvedAt).toBe("string");
  });

  test("defaults the approver to user and rejects empty fields", () => {
    expect(createDiffApproval("c", "diff").approvedBy).toBe("user");
    expect(() => createDiffApproval("  ", "diff")).toThrow(/non-empty id/);
    expect(() => createDiffApproval("c", "")).toThrow(/non-empty diff/);
    expect(() => createDiffApproval("c", "diff", "  ")).toThrow(/non-empty approver/);
  });
});
