import { describe, expect, test } from "bun:test";
import { AgencyError } from "@agency/schema";
import { applyEdit, applyEditsVerified, applyEditVerified, errorDiagnostics } from "../src/edit-engine.ts";

describe("applyEdit exact-match semantics (unchanged)", () => {
  test("replaces a uniquely-occurring region", () => {
    expect(applyEdit("const x = 1;\n", { oldText: "1;", newText: "2;" })).toBe("const x = 2;\n");
  });

  test("rejects when the anchor is truly absent (content differs)", () => {
    expect(() => applyEdit("const x = 1;\n", { oldText: "const y = 1;", newText: "y" })).toThrow(AgencyError);
  });

  test("rejects ambiguous exact matches without replaceAll", () => {
    expect(() => applyEdit("x = 1;\nx = 1;\n", { oldText: "x = 1;", newText: "x = 2;" })).toThrow(
      /appears 2 times/,
    );
  });

  test("empty oldText is always rejected", () => {
    expect(() => applyEdit("abc", { oldText: "", newText: "x" })).toThrow(AgencyError);
  });
});

describe("applyEdit whitespace-tolerant fallback (A6)", () => {
  test("matches modulo indentation drift and re-aligns the replacement", () => {
    const content = "function f() {\n    if (x) {\n        return 1;\n    }\n}\n";
    const result = applyEdit(content, {
      oldText: "if (x) {\n  return 1;\n}",
      newText: "if (x) {\n  return 2;\n}",
    });
    expect(result).toBe("function f() {\n    if (x) {\n        return 2;\n    }\n}\n");
  });

  test("matches modulo \\r\\n line endings", () => {
    const content = "a\r\nb\r\nc\r\n";
    expect(applyEdit(content, { oldText: "a\nb", newText: "X" })).toBe("X\r\nc\r\n");
  });

  test("matches modulo internal whitespace runs", () => {
    const content = "const  x  =  1;\n";
    expect(applyEdit(content, { oldText: "const x = 1;", newText: "const x = 2;" })).toBe(
      "const  x  =  2;\n",
    );
  });

  test("tolerates a trailing-newline anchor against EOF without one", () => {
    const content = "value";
    expect(applyEdit(content, { oldText: "value\n", newText: "value2\n" })).toBe("value2\n");
  });

  test("never matches across content differences", () => {
    expect(() => applyEdit("return 1;\n", { oldText: "return 2;", newText: "x" })).toThrow(AgencyError);
    expect(() => applyEdit("return1;\n", { oldText: "return 1;", newText: "x" })).toThrow(AgencyError);
  });

  test("a fuzzy match appearing twice is still ambiguous", () => {
    const content = "  foo(1);\n  foo(1);\n";
    expect(() => applyEdit(content, { oldText: "foo( 1 );", newText: "bar" })).toThrow(/appears 2 times/);
  });
});

describe("multi-hunk edits (A6)", () => {
  test("applyEditsVerified applies hunks in order and reads diagnostics once", () => {
    const outcome = applyEditsVerified(
      "const a = 1;\nconst b = 2;\n",
      [
        { oldText: "a = 1", newText: "a = 11" },
        { oldText: "b = 2", newText: "b = 22" },
      ],
      {
        path: "a.ts",
        diagnostics: () => [{ severity: 1, message: "boom", line: 0, character: 6 }],
      },
    );
    expect(outcome.content).toBe("const a = 11;\nconst b = 22;\n");
    expect(outcome.warnings).toEqual(["1:7 boom"]);
  });

  test("a rejected hunk means nothing is applied (all-or-nothing)", () => {
    expect(() =>
      applyEditsVerified("const a = 1;\n", [
        { oldText: "a = 1", newText: "a = 2" },
        { oldText: "not present", newText: "x" },
      ]),
    ).toThrow(AgencyError);
  });

  test("applyEditVerified still works for the single-hunk form", () => {
    expect(applyEditVerified("abc", { oldText: "b", newText: "B" })).toEqual({
      content: "aBc",
      warnings: [],
    });
    expect(errorDiagnostics([{ severity: 2, message: "warn", line: 0, character: 0 }])).toEqual([]);
  });
});
