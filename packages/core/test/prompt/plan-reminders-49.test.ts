import { describe, expect, test } from "bun:test";
import {
  allPlanWorkflowReminders,
  composeSystemPrompt,
  PLAN_WORKFLOW_PHASES,
  SessionReminders,
  SYSTEM_REMINDER_CLOSE,
  SYSTEM_REMINDER_OPEN,
} from "../../src/prompt/index.ts";

function base() {
  return composeSystemPrompt({ base: "identity", instructions: [], toolDescriptions: [] });
}

describe("SessionReminders 5-phase plan workflow", () => {
  test("exactly five phases", () => {
    expect(PLAN_WORKFLOW_PHASES.length).toBe(5);
    expect(allPlanWorkflowReminders().length).toBe(5);
  });

  test("apply renders one <system-reminder> block", () => {
    const composed = SessionReminders.apply(base(), SessionReminders.allPlanPhases());
    expect(composed.reminders?.length).toBe(5);
    expect(composed.text).toContain(SYSTEM_REMINDER_OPEN);
    expect(composed.text).toContain(SYSTEM_REMINDER_CLOSE);
    expect(composed.text).toContain(".opencode/plans/<epoch>-<slug>.md");
    expect(composed.text).toContain("plan_exit");
  });

  test("single phase applies alone", () => {
    const composed = SessionReminders.apply(base(), [SessionReminders.planWorkflow("explore")]);
    expect(composed.reminders?.length).toBe(1);
    expect(composed.text).toContain("1/5");
  });

  test("empty reminders leave the prompt untouched", () => {
    const before = base();
    const after = SessionReminders.apply(before, []);
    expect(after.text).toBe(before.text);
    expect(after.reminders).toBeUndefined();
  });
});
