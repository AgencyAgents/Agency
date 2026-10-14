import { describe, expect, test } from "bun:test";
import type { SessionEntry } from "../../src/sessions/entry.ts";
import { getSessionGoal, goalNotMetMessage, parseGoalVerdict } from "../../src/sessions/goal.ts";

const entry = (id: string, fields: Record<string, unknown>): SessionEntry => ({
  id,
  parentId: null,
  schemaVersion: 2,
  createdAt: "",
  type: "session_goal",
  ...fields,
});

describe("getSessionGoal", () => {
  test("the newest goal entry is the goal", () => {
    expect(getSessionGoal([entry("a", { goal: "tests pass" }), entry("b", { goal: "lint is clean" })])).toBe(
      "lint is clean",
    );
  });

  test("an empty goal entry clears the goal", () => {
    expect(getSessionGoal([entry("a", { goal: "tests pass" }), entry("b", { goal: "" })])).toBeUndefined();
  });

  test("a session with no goal entry has no goal", () => {
    expect(getSessionGoal([entry("a", { type: "message" })])).toBeUndefined();
  });
});

describe("parseGoalVerdict", () => {
  test("reads a met verdict", () => {
    expect(parseGoalVerdict("MET")).toEqual({ met: true, reason: "" });
    expect(parseGoalVerdict("**Met.**")?.met).toBe(true);
  });

  test("reads a not met verdict with its reason", () => {
    expect(parseGoalVerdict("NOT MET: two tests still fail")).toEqual({
      met: false,
      reason: "two tests still fail",
    });
    expect(parseGoalVerdict("Not met - the file is missing")?.met).toBe(false);
  });

  test("a reply that is not a verdict gives no verdict", () => {
    expect(parseGoalVerdict("I think the agent did well.")).toBeUndefined();
    expect(parseGoalVerdict("")).toBeUndefined();
  });
});

test("the not met message names the goal and the reason", () => {
  const message = goalNotMetMessage("tests pass", "two tests still fail");
  expect(message).toContain("two tests still fail");
  expect(message).toContain("Goal: tests pass");
});
