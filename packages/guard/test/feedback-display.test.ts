import { describe, expect, test } from "bun:test";
import { formatGateForDisplay, formatSkipForDisplay } from "../src/policy.ts";

// U9 reason codes, consumed here as literals so guard stays dependency free.
const SKIP_REASONS = [
  "empty-input",
  "invalid-entry",
  "unknown-handle",
  "nested-blocked",
  "depth-limit",
  "team-budget-exceeded",
  "per-agent-budget-exceeded",
] as const;

// U10 gate reason codes, consumed as literals for the same reason.
const GATE_REASONS = [
  "pass-clean",
  "pass-advisory-only",
  "fail-blocking-severity",
  "fail-unresolved-comments",
] as const;

describe("skip reason display", () => {
  test("every U9 skip reason renders with its stable token", () => {
    for (const reason of SKIP_REASONS) {
      const line = formatSkipForDisplay(reason, "detail here");
      expect(line).toContain(`[skip:${reason}]`);
      expect(line).toContain("detail here");
    }
  });

  test("skip display names the affected handle when given", () => {
    const line = formatSkipForDisplay("unknown-handle", "unknown handle: ghost", "ghost");
    expect(line).toContain("ghost");
    expect(line).toContain("[skip:unknown-handle]");
  });
});

describe("gate reason display", () => {
  test("every U10 gate reason renders with its stable token", () => {
    for (const reason of GATE_REASONS) {
      const line = formatGateForDisplay(reason, "gate detail");
      expect(line).toContain(reason);
      expect(line).toContain("gate detail");
    }
  });

  test("failing gates read as blocked, passing gates read as passed", () => {
    expect(formatGateForDisplay("fail-blocking-severity", "d")).toContain("blocked");
    expect(formatGateForDisplay("fail-unresolved-comments", "d")).toContain("blocked");
    expect(formatGateForDisplay("pass-clean", "d")).toContain("passed");
    expect(formatGateForDisplay("pass-advisory-only", "d")).toContain("passed");
  });
});
