import { describe, expect, test } from "bun:test";
import { composeSystemPrompt } from "../../src/prompt/compose.ts";
import { PROMPT_VERSION, withPromptVersion } from "../../src/prompt/version.ts";

describe("PROMPT_VERSION", () => {
  test("is a non-empty semver string", () => {
    expect(PROMPT_VERSION.length).toBeGreaterThan(0);
    expect(PROMPT_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  test("must be bumped when prompt content changes - pin test", () => {
    // If this test fails, you changed the prompt version constant without
    // updating the expected value. Confirm the bump is intentional.
    expect(PROMPT_VERSION).toBe("1.0.0");
  });
});

describe("withPromptVersion", () => {
  test("appends a tagged version block to the composed text", () => {
    const composed = composeSystemPrompt({ base: "BASE", instructions: [], toolDescriptions: [] });
    const versioned = withPromptVersion(composed);
    expect(versioned.text).toContain(`<prompt-version>${PROMPT_VERSION}</prompt-version>`);
    expect(versioned.text).toBe(`${composed.text}\n\n<prompt-version>${PROMPT_VERSION}</prompt-version>`);
  });

  test("returns the same sections and does not mutate the original", () => {
    const composed = composeSystemPrompt({ base: "BASE", instructions: ["X"], toolDescriptions: [] });
    const versioned = withPromptVersion(composed);
    expect(versioned.sections).toBe(composed.sections);
    expect(versioned.text).not.toBe(composed.text);
  });

  test("stable prefix (without version) is still a prefix of the versioned text", () => {
    const composed = composeSystemPrompt({
      base: "BASE",
      instructions: ["INSTR"],
      toolDescriptions: ["TOOL"],
      context: "ENV",
    });
    const versioned = withPromptVersion(composed);
    expect(versioned.text.startsWith(composed.text)).toBe(true);
    expect(versioned.text.length).toBeGreaterThan(composed.text.length);
  });
});
