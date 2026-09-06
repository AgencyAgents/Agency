import { describe, expect, test } from "bun:test";
import {
  composeSystemPrompt,
  describePrompt,
  fileChangedReminder,
  formatSystemReminders,
  mcpServerDownReminder,
  readOnlyReminder,
  resolveFamilyPrompt,
  withSystemReminders,
} from "../../src/prompt/compose.ts";

describe("composeSystemPrompt", () => {
  test("joins sections team-shared first: base, instructions, family overlay, tools", () => {
    const composed = composeSystemPrompt({
      base: "BASE",
      familyPresetOverlay: "OVERLAY",
      instructions: ["INSTR1", "INSTR2"],
      toolDescriptions: ["TOOL1"],
    });
    expect(composed.text).toBe("BASE\n\nINSTR1\n\nINSTR2\n\nOVERLAY\n\nTOOL1");
    expect(composed.segments.map((s) => s.stability)).toEqual(["shared", "shared", "agent", "agent"]);
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

  test("stable prefix (base+instructions+overlay+tools) is identical when only context changes — cache hit property", () => {
    const stable = {
      base: "BASE",
      familyPresetOverlay: "OVERLAY",
      instructions: ["INSTR"],
      toolDescriptions: ["TOOL"],
    };
    const withContextA = composeSystemPrompt({ ...stable, context: "CONTEXT_A" });
    const withContextB = composeSystemPrompt({ ...stable, context: "CONTEXT_B" });

    // The stable prefix (everything before the dynamic context) must be identical
    const prefixA = withContextA.text.slice(0, withContextA.text.indexOf("CONTEXT_A"));
    const prefixB = withContextB.text.slice(0, withContextB.text.indexOf("CONTEXT_B"));
    expect(prefixA).toBe(prefixB);

    // The full texts differ because the dynamic tail changed
    expect(withContextA.text).not.toBe(withContextB.text);
  });

  test("stable prefix survives when reminders are appended — cache hit property", () => {
    const sections = { base: "BASE", instructions: ["INSTR"], toolDescriptions: ["TOOL"] };
    const composed = composeSystemPrompt(sections);
    const withReminder = withSystemReminders(composed, [readOnlyReminder()]);

    // The composed text (without reminders) must be a prefix of the text with reminders
    expect(withReminder.text.startsWith(composed.text)).toBe(true);
    expect(withReminder.text.length).toBeGreaterThan(composed.text.length);
  });

  test("stable prefix is identical when both context and reminders change independently", () => {
    const stable = { base: "BASE", instructions: ["INSTR"], toolDescriptions: ["TOOL"] };
    const base = composeSystemPrompt(stable);

    // With context only
    const withContext = composeSystemPrompt({ ...stable, context: "ENV" });
    expect(withContext.text.startsWith(base.text)).toBe(true);

    // With reminders only (no context)
    const withReminders = withSystemReminders(base, [readOnlyReminder()]);
    expect(withReminders.text.startsWith(base.text)).toBe(true);

    // With both context and reminders
    const withBoth = withSystemReminders(composeSystemPrompt({ ...stable, context: "ENV" }), [
      readOnlyReminder(),
    ]);
    expect(withBoth.text.startsWith(base.text)).toBe(true);
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

describe("resolveFamilyPrompt", () => {
  test("anthropic family returns mechanics-driven prompt for coder role", () => {
    const prompt = resolveFamilyPrompt("anthropic", "coder");
    expect(prompt).toContain("Your job is to:");
    expect(prompt).toContain("1.");
    expect(prompt).toContain("2.");
    expect(prompt).toContain("Do not modify .opencode/plans/");
  });

  test("openai family returns principle-driven prompt for coder role", () => {
    const prompt = resolveFamilyPrompt("openai", "coder");
    // Principle-driven: concise, no numbered steps
    expect(prompt).not.toContain("Your job is to:");
    expect(prompt).not.toMatch(/\d\.\s/);
    expect(prompt).toContain("coder");
    expect(prompt).toContain("write/edit");
  });

  test("anthropic and openai produce materially different text for same role", () => {
    const anthropic = resolveFamilyPrompt("anthropic", "coder");
    const openai = resolveFamilyPrompt("openai", "coder");
    expect(anthropic).not.toBe(openai);
    // Anthropic has numbered steps, openai does not
    expect(anthropic.split("\n").length).toBeGreaterThan(openai.split("\n").length);
  });

  test("unknown family falls back to principle-driven (same as openai)", () => {
    const unknown = resolveFamilyPrompt("unknown-vendor", "coder");
    const openai = resolveFamilyPrompt("openai", "coder");
    expect(unknown).toBe(openai);
  });

  test("deepseek family falls back to principle-driven", () => {
    const deepseek = resolveFamilyPrompt("deepseek", "coder");
    const openai = resolveFamilyPrompt("openai", "coder");
    expect(deepseek).toBe(openai);
  });

  test("glm family falls back to principle-driven", () => {
    const glm = resolveFamilyPrompt("glm", "coder");
    const openai = resolveFamilyPrompt("openai", "coder");
    expect(glm).toBe(openai);
  });

  test("google family falls back to principle-driven", () => {
    const google = resolveFamilyPrompt("google", "coder");
    const openai = resolveFamilyPrompt("openai", "coder");
    expect(google).toBe(openai);
  });

  test("every role has a prompt for both anthropic and fallback", () => {
    const roles = [
      "leader",
      "planner",
      "plan-reviewer",
      "coder",
      "executor",
      "explorer",
      "researcher",
      "code-reviewer",
    ];
    for (const role of roles) {
      const anthropic = resolveFamilyPrompt("anthropic", role);
      const fallback = resolveFamilyPrompt("openai", role);
      expect(anthropic).toBeTruthy();
      expect(fallback).toBeTruthy();
      expect(anthropic.length).toBeGreaterThan(10);
      expect(fallback.length).toBeGreaterThan(10);
    }
  });

  test("unknown role gets a fallback string", () => {
    const prompt = resolveFamilyPrompt("anthropic", "nonexistent-role");
    expect(prompt).toBe("You are a nonexistent-role.");
  });
});

describe("persona-driven role prompts (MECHANICS — anthropic)", () => {
  const PERSONAS: Record<string, string> = {
    leader: "strategic commander",
    planner: "architect",
    "plan-reviewer": "auditor",
    coder: "craftsman",
    executor: "operator",
    explorer: "scout",
    researcher: "librarian",
    "code-reviewer": "inspector",
  };

  const OUTPUT_CONTRACTS: Record<string, string> = {
    leader: "[Summary:",
    planner: "[Plan:",
    "plan-reviewer": "[Verdict:",
    coder: "[Files:",
    executor: "[Exit:",
    explorer: "[Evidence:",
    researcher: "[Sources:",
    "code-reviewer": "[Issues:",
  };

  for (const [role, persona] of Object.entries(PERSONAS)) {
    test(`${role} has persona "${persona}" and output contract`, () => {
      const prompt = resolveFamilyPrompt("anthropic", role);
      expect(prompt).toContain(persona);
      expect(prompt).toContain(OUTPUT_CONTRACTS[role]!);
      expect(prompt).toContain("Tools:");
      expect(prompt).toContain("MUST NOT:");
      expect(prompt).toContain("Output contract:");
    });
  }

  test("room roles (leader, coder, executor) include room protocol", () => {
    for (const role of ["leader", "coder", "executor"]) {
      expect(resolveFamilyPrompt("anthropic", role)).toContain("Team protocol:");
    }
  });

  test("non-room roles exclude room protocol", () => {
    for (const role of ["planner", "plan-reviewer", "explorer", "researcher", "code-reviewer"]) {
      expect(resolveFamilyPrompt("anthropic", role)).not.toContain("Team protocol:");
    }
  });
});

describe("persona-driven role prompts (PRINCIPLE — openai/fallback)", () => {
  const PERSONAS: Record<string, string> = {
    leader: "Strategic commander",
    planner: "Architect",
    "plan-reviewer": "Auditor",
    coder: "Craftsman",
    executor: "Operator",
    explorer: "Scout",
    researcher: "Librarian",
    "code-reviewer": "Inspector",
  };

  const OUTPUT_CONTRACTS: Record<string, string> = {
    leader: "[Summary:",
    planner: "[Plan:",
    "plan-reviewer": "[Verdict:",
    coder: "[Files:",
    executor: "[Exit:",
    explorer: "[Evidence:",
    researcher: "[Sources:",
    "code-reviewer": "[Issues:",
  };

  for (const [role, persona] of Object.entries(PERSONAS)) {
    test(`${role} has persona "${persona}" and output contract`, () => {
      const prompt = resolveFamilyPrompt("openai", role);
      expect(prompt).toContain(persona);
      expect(prompt).toContain(OUTPUT_CONTRACTS[role]!);
      expect(prompt).toContain("Tools:");
      expect(prompt).toContain("MUST NOT");
      expect(prompt).toContain("Output contract:");
    });
  }

  test("principle prompts are concise (one paragraph, no numbered steps)", () => {
    for (const role of [
      "leader",
      "planner",
      "plan-reviewer",
      "coder",
      "executor",
      "explorer",
      "researcher",
      "code-reviewer",
    ]) {
      const prompt = resolveFamilyPrompt("openai", role);
      expect(prompt).not.toMatch(/\d\.\s/);
      expect(prompt).not.toContain("Your job is to:");
    }
  });
});

describe("cache-prefix order with role prompts", () => {
  test("team-shared instructions appear before the per-agent role prompt", () => {
    const composed = composeSystemPrompt({
      base: "identity",
      familyPresetOverlay: resolveFamilyPrompt("anthropic", "coder"),
      instructions: ["custom instructions"],
      toolDescriptions: ["tool: read"],
    });
    const overlayIdx = composed.text.indexOf("craftsman");
    const instrIdx = composed.text.indexOf("custom instructions");
    expect(overlayIdx).toBeGreaterThan(0);
    expect(instrIdx).toBeGreaterThanOrEqual(0);
    expect(instrIdx).toBeLessThan(overlayIdx);
  });

  test("context (environment block) is joined last, after role prompt and instructions", () => {
    const composed = composeSystemPrompt({
      base: "identity",
      familyPresetOverlay: resolveFamilyPrompt("anthropic", "coder"),
      instructions: ["custom instructions"],
      toolDescriptions: ["tool: read"],
      context: "<environment>ENV</environment>",
    });
    const envIdx = composed.text.indexOf("<environment>");
    const instrIdx = composed.text.indexOf("custom instructions");
    expect(envIdx).toBeGreaterThan(instrIdx);
    expect(composed.text.endsWith("<environment>ENV</environment>")).toBe(true);
  });
});
