import { describe, expect, test } from "bun:test";
import { t } from "../src/index.ts";

describe("t", () => {
  test("interpolates placeholders from params", () => {
    expect(t("error.network", { source: "Anthropic" })).toBe(
      "Couldn't reach Anthropic. Check your connection and try again.",
    );
  });

  test("leaves an unmatched placeholder token untouched", () => {
    expect(t("error.tool_error", { source: "bash" })).toBe("The bash tool failed: {detail}");
  });

  test("every schema error code has a corresponding catalog entry", async () => {
    const { ErrorCode } = await import("@agency/schema");
    const { en } = await import("../src/en.ts");
    for (const code of Object.values(ErrorCode)) {
      expect(Object.hasOwn(en, `error.${code}`)).toBe(true);
    }
  });
});
