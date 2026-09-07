import { describe, expect, test } from "bun:test";
import { AgencyError, ErrorCode } from "@agency/schema";
import { applyEdit, applyEditsVerified, applyEditVerified, errorDiagnostics } from "../src/edit-engine.ts";

describe("applyEdit", () => {
  test("replaces a uniquely-occurring region", () => {
    const content = "function foo() {\n  return 1;\n}\n";
    const result = applyEdit(content, { oldText: "return 1;", newText: "return 2;" });
    expect(result).toBe("function foo() {\n  return 2;\n}\n");
  });

  test("rejects rather than misapplies when the anchor text isn't found", () => {
    const content = "const x = 1;\n";
    expect(() => applyEdit(content, { oldText: "const y = 1;", newText: "const y = 2;" })).toThrow(
      AgencyError,
    );
  });

  test("the not-found rejection carries TOOL_ERROR, not a generic exception", () => {
    const content = "const x = 1;\n";
    const err = (() => {
      try {
        applyEdit(content, { oldText: "nope", newText: "x" });
        return undefined;
      } catch (e) {
        return e;
      }
    })();
    expect((err as AgencyError).code).toBe(ErrorCode.TOOL_ERROR);
  });

  test("rejects an ambiguous edit that matches more than once without replaceAll", () => {
    const content = "x = 1;\nx = 1;\n";
    expect(() => applyEdit(content, { oldText: "x = 1;", newText: "x = 2;" })).toThrow(/appears 2 times/);
  });

  test("replaceAll replaces every occurrence deliberately", () => {
    const content = "x = 1;\nx = 1;\nx = 1;\n";
    const result = applyEdit(content, { oldText: "x = 1;", newText: "x = 2;", replaceAll: true });
    expect(result).toBe("x = 2;\nx = 2;\nx = 2;\n");
  });

  test("never partially applies on rejection: content is returned unchanged, not mutated", () => {
    const content = "const x = 1;\n";
    try {
      applyEdit(content, { oldText: "not there", newText: "x" });
    } catch {
      // expected
    }
    // Strings are immutable in JS, but this documents the invariant explicitly:
    // applyEdit never returns a partial result on the throw path above.
    expect(content).toBe("const x = 1;\n");
  });

  test("an empty oldText is always rejected rather than treated as a wildcard insert", () => {
    expect(() => applyEdit("abc", { oldText: "", newText: "x" })).toThrow(AgencyError);
  });

  test("preserves surrounding content exactly, including whitespace", () => {
    const content = "line1\n  line2\nline3";
    const result = applyEdit(content, { oldText: "line2", newText: "replaced" });
    expect(result).toBe("line1\n  replaced\nline3");
  });
});

describe("errorDiagnostics", () => {
  test("keeps only error-severity diagnostics, formatted 1-based", () => {
    const warnings = errorDiagnostics([
      { severity: 1, message: "boom", line: 2, character: 4 },
      { severity: 2, message: "meh", line: 0, character: 0 },
      { severity: 1, message: "also boom", line: 9, character: 0 },
    ]);
    expect(warnings).toEqual(["3:5 boom", "10:1 also boom"]);
  });
});

describe("applyEditVerified", () => {
  test("applies the edit and surfaces error diagnostics as warnings", () => {
    const outcome = applyEditVerified(
      "const x = 1;\n",
      { oldText: "1", newText: "2" },
      {
        path: "a.ts",
        diagnostics: (path) =>
          path === "a.ts" ? [{ severity: 1, message: "boom", line: 0, character: 6 }] : [],
      },
    );
    expect(outcome.content).toBe("const x = 2;\n");
    expect(outcome.warnings).toEqual(["1:7 boom"]);
  });

  test("no provider or no path means no warnings and a plain edit", () => {
    const outcome = applyEditVerified("abc", { oldText: "b", newText: "B" });
    expect(outcome).toEqual({ content: "aBc", warnings: [] });
  });
});

describe("applyEdit hashline match (sha256 content-hash)", () => {
  test("matches when indentation differs but line content is the same", () => {
    const content = "function f() {\n    return 1;\n}\n";
    const result = applyEdit(content, {
      oldText: "  return 1;",
      newText: "  return 2;",
    });
    expect(result).toBe("function f() {\n    return 2;\n}\n");
  });

  test("matches when internal whitespace runs differ", () => {
    const content = "const  x  =  1;\n";
    const result = applyEdit(content, {
      oldText: "const x = 1;",
      newText: "const x = 2;",
    });
    expect(result).toBe("const  x  =  2;\n");
  });

  test("matches multi-line with mixed whitespace drift", () => {
    const content = "function f() {\n    if (x) {\n        return 1;\n    }\n}\n";
    const result = applyEdit(content, {
      oldText: "if (x) {\n  return 1;\n}",
      newText: "if (x) {\n  return 2;\n}",
    });
    expect(result).toBe("function f() {\n    if (x) {\n        return 2;\n    }\n}\n");
  });

  test("rejects when content differs (hash mismatch)", () => {
    expect(() => applyEdit("return 1;\n", { oldText: "return 2;", newText: "x" })).toThrow(AgencyError);
  });

  test("rejects when a token is fused (no whitespace between words)", () => {
    expect(() => applyEdit("return1;\n", { oldText: "return 1;", newText: "x" })).toThrow(AgencyError);
  });

  test("ambiguous hashline match without replaceAll throws", () => {
    const content = "  foo(1);\n  foo(1);\n";
    expect(() => applyEdit(content, { oldText: "foo( 1 );", newText: "bar" })).toThrow(/appears 2 times/);
  });

  test("hashline match with replaceAll replaces all occurrences", () => {
    const content = "  foo(1);\n  foo(1);\n";
    const result = applyEdit(content, {
      oldText: "foo( 1 );",
      newText: "bar(1);",
      replaceAll: true,
    });
    expect(result).toBe("  bar(1);\n  bar(1);\n");
  });

  test("hashline match preserves surrounding content exactly", () => {
    const content = "line1\n  line2\nline3";
    const result = applyEdit(content, {
      oldText: " line2",
      newText: " replaced",
    });
    expect(result).toBe("line1\n  replaced\nline3");
  });

  test("context-sensitive WS: return 1 does not match return1 (word-word boundary)", () => {
    // Space between two word chars requires at least one whitespace
    expect(() => applyEdit("return1;\n", { oldText: "return 1;", newText: "x" })).toThrow(AgencyError);
  });

  test("context-sensitive WS: foo( 1) matches foo(1) (non-word-word boundary)", () => {
    // Space between non-word ( and word 1 is optional
    const result = applyEdit("foo(1);\n", {
      oldText: "foo( 1);",
      newText: "bar(1);",
    });
    expect(result).toBe("bar(1);\n");
  });

  test("context-sensitive WS: preserves internal WS alignment in replacement", () => {
    const result = applyEdit("foo(  1);\n", {
      oldText: "foo( 1);",
      newText: "bar(x);",
    });
    expect(result).toBe("bar(x);\n");
  });

  test("hashline match handles trailing-newline anchor against EOF", () => {
    const content = "value";
    expect(applyEdit(content, { oldText: "value\n", newText: "value2\n" })).toBe("value2\n");
  });

  test("hashline match handles \\r\\n line endings", () => {
    const content = "a\r\nb\r\nc\r\n";
    expect(applyEdit(content, { oldText: "a\nb", newText: "X" })).toBe("X\r\nc\r\n");
  });
});

describe("applyEditsVerified bottom-to-top ordering and dedupe", () => {
  test("applies hunks bottom-to-top so earlier-line edits are not shifted", () => {
    const outcome = applyEditsVerified("a\nb\nc\n", [
      { oldText: "a", newText: "A" },
      { oldText: "c", newText: "C" },
    ]);
    // c → C applied first (bottom), then a → A (top) — both succeed
    expect(outcome.content).toBe("A\nb\nC\n");
  });

  test("dedupes overlapping hunks (keeps bottom-most)", () => {
    const outcome = applyEditsVerified("function f() {\n  return 1;\n}\n", [
      { oldText: "return 1", newText: "return 11" },
      { oldText: "return 1;\n}", newText: "return 2;\n}" },
    ]);
    // Both match overlapping region; second (bottom-most) wins
    expect(outcome.content).toBe("function f() {\n  return 2;\n}\n");
  });

  test("non-overlapping hunks all apply regardless of input order", () => {
    const outcome = applyEditsVerified("const a = 1;\nconst b = 2;\nconst c = 3;\n", [
      { oldText: "c = 3", newText: "c = 33" },
      { oldText: "a = 1", newText: "a = 11" },
      { oldText: "b = 2", newText: "b = 22" },
    ]);
    expect(outcome.content).toBe("const a = 11;\nconst b = 22;\nconst c = 33;\n");
  });

  test("a rejected hunk still means nothing is applied (all-or-nothing)", () => {
    expect(() =>
      applyEditsVerified("const a = 1;\n", [
        { oldText: "a = 1", newText: "a = 2" },
        { oldText: "not present", newText: "x" },
      ]),
    ).toThrow(AgencyError);
  });

  test("reads diagnostics once after all hunks applied", () => {
    let callCount = 0;
    const outcome = applyEditsVerified(
      "const a = 1;\nconst b = 2;\n",
      [
        { oldText: "a = 1", newText: "a = 11" },
        { oldText: "b = 2", newText: "b = 22" },
      ],
      {
        path: "a.ts",
        diagnostics: () => {
          callCount++;
          return [{ severity: 1, message: "boom", line: 0, character: 6 }];
        },
      },
    );
    expect(outcome.content).toBe("const a = 11;\nconst b = 22;\n");
    expect(outcome.warnings).toEqual(["1:7 boom"]);
    expect(callCount).toBe(1);
  });
});
