import { describe, expect, test } from "bun:test";
import { EmptyStateView } from "../src/empty.ts";
import { HelpSystem } from "../src/help.ts";
import { StatusLine } from "../src/status.ts";
import { createTheme } from "../src/theme.ts";

const theme = createTheme();
const noColor = false;
const withColor = true;

describe("StatusLine", () => {
  test("empty info renders empty string", () => {
    const line = new StatusLine(theme, noColor);
    expect(line.render({})).toBe("");
  });

  test("renders model, thinking, context, and cost joined by pipe", () => {
    const line = new StatusLine(theme, noColor);
    const out = line.render({ model: "gpt-5.2", thinkingLevel: "high", contextUsed: 1200, contextTotal: 200000, costUsd: 0.0421 });
    expect(out).toContain("gpt-5.2");
    expect(out).toContain("high");
    expect(out).toContain("1200");
    expect(out).toContain("200000");
    expect(out).toContain("0.0421");
    expect(out).toContain(" | ");
  });

  test("partial fields render only what is present", () => {
    const line = new StatusLine(theme, noColor);
    expect(line.render({ model: "claude" })).toContain("claude");
    expect(line.render({ costUsd: 1.5 })).toContain("1.5000");
    expect(line.render({ contextUsed: 5, contextTotal: 10 })).toContain("5");
  });

  test("color enabled wraps with ANSI", () => {
    const line = new StatusLine(theme, withColor);
    const out = line.render({ model: "x" });
    expect(out).toContain("\x1b[");
  });
});

describe("EmptyStateView", () => {
  test("every state renders a non-empty line", () => {
    const view = new EmptyStateView(theme, noColor);
    const states = ["first_run", "no_credentials", "offline", "rate_limited", "cancelled", "no_sessions", "unknown"] as const;
    for (const s of states) {
      const lines = view.render(s as never);
      expect(lines.length).toBe(1);
      expect(lines[0]!.length).toBeGreaterThan(0);
    }
  });

  test("unknown state falls back to internal error", () => {
    const view = new EmptyStateView(theme, noColor);
    const lines = view.render("bogus" as never);
    expect(lines[0]).toBeDefined();
  });
});

describe("HelpSystem", () => {
  test("forPanel returns panel-specific entries", () => {
    const help = new HelpSystem();
    expect(help.forPanel("transcript").length).toBeGreaterThan(0);
    expect(help.forPanel("palette").length).toBeGreaterThan(0);
  });

  test("all() deduplicates across panels and is sorted", () => {
    const help = new HelpSystem();
    const all = help.all();
    expect(all.length).toBeGreaterThan(0);
    const keys = all.map((e) => e.key);
    const sorted = [...keys].sort((a, b) => a.localeCompare(b));
    expect(keys).toEqual(sorted);
  });

  test("hint shows once then disappears", () => {
    const help = new HelpSystem();
    const first = help.hint("transcript");
    expect(first).toBeDefined();
    expect(help.hint("transcript")).toBeUndefined();
  });

  test("isEscapable is true for every panel", () => {
    const help = new HelpSystem();
    for (const p of ["transcript", "browser", "diff", "palette", "models"] as const) expect(help.isEscapable(p)).toBe(true);
  });

  test("frame returns formatted lines", () => {
    const help = new HelpSystem();
    const frame = help.frame("transcript");
    expect(frame.length).toBeGreaterThan(0);
    expect(frame[0]).toContain("Ctrl");
  });
});
