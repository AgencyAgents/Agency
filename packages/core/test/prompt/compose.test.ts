import { describe, expect, test } from "bun:test";
import {
  composeSystemPrompt,
  describePrompt,
  fileChangedReminder,
  formatSystemReminders,
  mcpServerDownReminder,
  readOnlyReminder,
  withSystemReminders,
} from "../../src/prompt/compose.ts";

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

  test("joins the context section last, after tool descriptions", () => {
    const composed = composeSystemPrompt({
      base: "BASE",
      instructions: ["INSTR"],
      toolDescriptions: ["TOOL"],
      context: "<environment>ENV</environment>",
    });
    expect(composed.text).toBe("BASE\n\nINSTR\n\nTOOL\n\n<environment>ENV</environment>");
  });
});

describe("formatSystemReminders", () => {
  test("empty list renders nothing, so reminder-free turns are byte-identical", () => {
    expect(formatSystemReminders([])).toBe("");
  });

  test("wraps the active reminders in one tagged block", () => {
    const block = formatSystemReminders([
      { kind: "plan_mode", text: "plan mode on" },
      { kind: "file_changed", text: "a.ts changed" },
    ]);
    expect(block).toBe(
      "<system-reminder>\n- [plan_mode] plan mode on\n- [file_changed] a.ts changed\n</system-reminder>",
    );
  });
});

describe("withSystemReminders", () => {
  test("appends the reminder block and records the reminders", () => {
    const composed = composeSystemPrompt({ base: "BASE", instructions: [], toolDescriptions: [] });
    const reminders = [readOnlyReminder()];
    const withReminders = withSystemReminders(composed, reminders);

    expect(withReminders.reminders).toEqual(reminders);
    expect(withReminders.text).toBe(
      `${composed.text}\n\n<system-reminder>\n- [plan_mode] ${reminders[0]?.text}\n</system-reminder>`,
    );
  });

  test("returns the composed prompt unchanged when no reminders are active", () => {
    const composed = composeSystemPrompt({ base: "BASE", instructions: [], toolDescriptions: [] });
    expect(withSystemReminders(composed, [])).toBe(composed);
  });
});

describe("reminder factories", () => {
  test("each standard state maps to its kind", () => {
    expect(readOnlyReminder().kind).toBe("plan_mode");
    expect(fileChangedReminder("src/x.ts").kind).toBe("file_changed");
    expect(fileChangedReminder("src/x.ts").text).toContain("src/x.ts");
    expect(mcpServerDownReminder("fs").kind).toBe("mcp_server_down");
    expect(mcpServerDownReminder("fs").text).toContain('"fs"');
    expect(mcpServerDownReminder("fs", "timed out").text).toContain("timed out");
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

  test("includes context and reminders when present", () => {
    const composed = withSystemReminders(
      composeSystemPrompt({
        base: "BASE",
        instructions: [],
        toolDescriptions: [],
        context: "<environment>ENV</environment>",
      }),
      [readOnlyReminder()],
    );
    expect(describePrompt(composed).map((s) => s.label)).toEqual(["base", "context", "reminders"]);
  });
});
