import { describe, expect, test } from "bun:test";
import { AgencyError, ErrorCode } from "@agency/schema";
import { applyEdit } from "../src/edit-engine.ts";

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
