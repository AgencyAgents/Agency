import { describe, expect, test } from "bun:test";
import {
  applyEdit,
  applyEditsVerified,
  autocorrectHunk,
  isSlopLine,
  restorePairedIndent,
  stripTrailingSlop,
} from "../src/edit-engine.ts";

describe("isSlopLine", () => {
  test("bare continuation tokens are slop", () => {
    expect(isSlopLine("...")).toBe(true);
    expect(isSlopLine("  …  ")).toBe(true);
    expect(isSlopLine("⋯")).toBe(true);
  });

  test("comment continuation lines are slop", () => {
    expect(isSlopLine("// ...")).toBe(true);
    expect(isSlopLine("# ...")).toBe(true);
    expect(isSlopLine("/* ... */")).toBe(true);
    expect(isSlopLine("<!-- ... -->")).toBe(true);
    expect(isSlopLine("// rest of file unchanged")).toBe(true);
    expect(isSlopLine("# remaining code unchanged ...")).toBe(true);
    expect(isSlopLine("// ... truncated")).toBe(true);
  });

  test("merge chars and fences are slop", () => {
    expect(isSlopLine("```")).toBe(true);
    expect(isSlopLine("```typescript")).toBe(true);
    expect(isSlopLine("<<<<<<< HEAD")).toBe(true);
    expect(isSlopLine("=======")).toBe(true);
    expect(isSlopLine(">>>>>>> main")).toBe(true);
    expect(isSlopLine("@@ -1,2 +1,3 @@")).toBe(true);
  });

  test("real code and real comments are not slop", () => {
    expect(isSlopLine("return 2;")).toBe(false);
    expect(isSlopLine("// return the total")).toBe(false);
    expect(isSlopLine("# compute tax rate")).toBe(false);
    expect(isSlopLine("...spread")).toBe(false);
    expect(isSlopLine("")).toBe(false);
    expect(isSlopLine("   ")).toBe(false);
    expect(isSlopLine("a = 1; // set a")).toBe(false);
  });
});

describe("stripTrailingSlop", () => {
  test("strips trailing slop lines, keeps the anchor", () => {
    const { text, stripped } = stripTrailingSlop("return 1;\n// ...\n...");
    expect(text).toBe("return 1;");
    expect(stripped).toEqual(["// ...", "..."]);
  });

  test("preserves a trailing newline", () => {
    expect(stripTrailingSlop("return 1;\n// ...\n").text).toBe("return 1;\n");
  });

  test("never strips the last content line", () => {
    const { text, stripped } = stripTrailingSlop("...");
    expect(text).toBe("...");
    expect(stripped).toEqual([]);
  });

  test("clean text passes through untouched", () => {
    const { text, stripped } = stripTrailingSlop("a\nb");
    expect(text).toBe("a\nb");
    expect(stripped).toEqual([]);
  });
});

describe("restorePairedIndent", () => {
  test("flat newText regains oldText indentation per line", () => {
    const oldText = "    return 1;\n    return 2;";
    expect(restorePairedIndent(oldText, "return 1;\nreturn 3;")).toBe("    return 1;\n    return 3;");
  });

  test("mismatched line counts are left alone", () => {
    expect(restorePairedIndent("  a\n  b", "a\nb\nc")).toBe("a\nb\nc");
  });

  test("already-indented newText is never clobbered", () => {
    expect(restorePairedIndent("  x", "    x")).toBe("    x");
  });

  test("flat pairs with flat old side stay flat", () => {
    expect(restorePairedIndent("x", "y")).toBe("y");
  });
});

describe("autocorrectHunk + applyEdit end-to-end (item 54)", () => {
  test("trailing continuation tokens no longer reject the patch", () => {
    const content = "function f() {\n  return 1;\n}\n";
    const result = applyEdit(content, {
      oldText: "  return 1;\n  // ...",
      newText: "  return 2;\n  // ...",
    });
    expect(result).toBe("function f() {\n  return 2;\n}\n");
  });

  test("trailing merge markers are stripped before patch", () => {
    const content = "const x = 1;\n";
    const result = applyEdit(content, {
      oldText: "const x = 1;\n>>>>>>> main",
      newText: "const x = 2;\n>>>>>>> main",
    });
    expect(result).toBe("const x = 2;\n");
  });

  test("flat paired replacement is re-indented", () => {
    const content = "function f() {\n    return 1;\n}\n";
    const result = applyEdit(content, {
      oldText: "    return 1;",
      newText: "return 2;",
    });
    expect(result).toBe("function f() {\n    return 2;\n}\n");
  });

  test("autocorrectHunk reports notes and preserves replaceAll", () => {
    const fixed = autocorrectHunk({
      oldText: "x = 1;\n...",
      newText: "x = 2;\n...",
      replaceAll: true,
    });
    expect(fixed.corrected).toBe(true);
    expect(fixed.hunk).toEqual({ oldText: "x = 1;", newText: "x = 2;", replaceAll: true });
    expect(fixed.notes.length).toBeGreaterThan(0);
  });

  test("clean hunks pass through unmarked", () => {
    const hunk = { oldText: "a", newText: "b" };
    const fixed = autocorrectHunk(hunk);
    expect(fixed.corrected).toBe(false);
    expect(fixed.hunk).toEqual(hunk);
  });

  test("applyEditsVerified autocorrects every hunk before positioning", () => {
    const outcome = applyEditsVerified("const a = 1;\nconst b = 2;\n", [
      { oldText: "a = 1\n// ...", newText: "a = 11\n// ..." },
      { oldText: "b = 2\n```", newText: "b = 22\n```" },
    ]);
    expect(outcome.content).toBe("const a = 11;\nconst b = 22;\n");
  });

  test("genuine mismatches still reject (autocorrect invents nothing)", () => {
    expect(() => applyEdit("const x = 1;\n", { oldText: "const y = 9;", newText: "z" })).toThrow();
  });
});
