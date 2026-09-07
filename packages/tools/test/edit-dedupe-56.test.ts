import { describe, expect, test } from "bun:test";
import { applyEditsVerified } from "../src/edit-engine.ts";

describe("applyEditsVerified dedupe + bottom-to-top + overlap (item 56)", () => {
  test("exact-duplicate hunks apply once instead of double-applying", () => {
    const outcome = applyEditsVerified("const a = 1;\n", [
      { oldText: "a = 1", newText: "a = 2" },
      { oldText: "a = 1", newText: "a = 2" },
    ]);
    expect(outcome.content).toBe("const a = 2;\n");
  });

  test("triple duplicates collapse to a single application", () => {
    const outcome = applyEditsVerified("hello\n", [
      { oldText: "hello", newText: "hi" },
      { oldText: "hello", newText: "hi" },
      { oldText: "hello", newText: "hi" },
    ]);
    expect(outcome.content).toBe("hi\n");
  });

  test("same anchor with different replacements resolves to exactly one winner", () => {
    const outcome = applyEditsVerified("const a = 1;\n", [
      { oldText: "a = 1", newText: "a = 2" },
      { oldText: "a = 1", newText: "a = 3" },
    ]);
    expect(["const a = 2;\n", "const a = 3;\n"]).toContain(outcome.content);
  });

  test("same-line adjacent non-overlapping hunks both apply", () => {
    const outcome = applyEditsVerified("foo bar\n", [
      { oldText: "foo", newText: "FOO" },
      { oldText: "bar", newText: "BAR" },
    ]);
    expect(outcome.content).toBe("FOO BAR\n");
  });

  test("bottom insertion shifting lines does not break the top hunk", () => {
    const outcome = applyEditsVerified("line1\nline2\n", [
      { oldText: "line1", newText: "LINE1" },
      { oldText: "line2", newText: "line2\ninserted" },
    ]);
    expect(outcome.content).toBe("LINE1\nline2\ninserted\n");
  });

  test("nested overlapping hunks keep the bottom-most (longer span wins ties)", () => {
    const outcome = applyEditsVerified("function f() {\n  return 1;\n}\n", [
      { oldText: "return 1", newText: "return 11" },
      { oldText: "return 1;\n}", newText: "return 2;\n}" },
    ]);
    expect(outcome.content).toBe("function f() {\n  return 2;\n}\n");
  });

  test("duplicate replaceAll hunks run once with the same result", () => {
    const outcome = applyEditsVerified("a=1;\na=1;\n", [
      { oldText: "a=1", newText: "a=2", replaceAll: true },
      { oldText: "a=1", newText: "a=2", replaceAll: true },
    ]);
    expect(outcome.content).toBe("a=2;\na=2;\n");
  });
});
