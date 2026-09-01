import { describe, expect, test } from "bun:test";
import { composeSystemPrompt, describePrompt } from "../../src/prompt/compose.ts";

describe("composeSystemPrompt", () => {
  test("joins sections in the fixed order: base, family overlay, instructions, tools", () => {
    const composed = composeSystemPrompt({
      base: "BASE",
      familyPresetOverlay: "OVERLAY",
      instructions: ["INSTR1", "INSTR2"],
      toolDescriptions: ["TOOL1"],
    });
    const order = [
      composed.text.indexOf("BASE"),
      composed.text.indexOf("OVERLAY"),
      composed.text.indexOf("INSTR1"),
      composed.text.indexOf("TOOL1"),
    ];
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  test("is deterministic across calls with the same input, for prompt-cache stability", () => {
    const sections = { base: "BASE", instructions: ["A", "B"], toolDescriptions: ["T"] };
    expect(composeSystemPrompt(sections).text).toBe(composeSystemPrompt(sections).text);
  });

  test("omits absent optional sections cleanly", () => {
    const composed = composeSystemPrompt({ base: "BASE", instructions: [], toolDescriptions: [] });
    expect(composed.text).toBe("BASE");
  });
});

describe("describePrompt", () => {
  test("labels each resolved section for inspection", () => {
    const composed = composeSystemPrompt({
      base: "BASE",
      familyPresetOverlay: "OVERLAY",
      instructions: ["INSTR"],
      toolDescriptions: ["TOOL"],
    });
    const sections = describePrompt(composed);
    expect(sections.map((s) => s.label)).toEqual(["base", "family preset", "instructions[0]", "tool[0]"]);
  });
});
