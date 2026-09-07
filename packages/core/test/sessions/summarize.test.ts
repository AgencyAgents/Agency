import { describe, expect, test } from "bun:test";
import { summarizeTranscript } from "../../src/sessions/summarize.ts";

describe("summarizeTranscript", () => {
  test("returns an empty string for an empty transcript", () => {
    expect(summarizeTranscript("")).toBe("");
    expect(summarizeTranscript("\n  \n")).toBe("");
  });

  test("keeps short transcripts intact", () => {
    const text = "user asked about X\nassistant edited main.ts\nuser verified";
    expect(summarizeTranscript(text)).toBe(text);
  });

  test("elides the middle and keeps both ends within budget", () => {
    const lines = Array.from({ length: 200 }, (_, i) => `line ${i} ${"x".repeat(80)}`);
    const summary = summarizeTranscript(lines.join("\n"), 2000);

    expect(summary).toContain("[… ");
    expect(summary).toContain("earlier lines elided …]");
    expect(summary).toContain(lines[0]!);
    expect(summary).toContain(lines.at(-1)!);
    // The middle is genuinely gone.
    expect(summary).not.toContain("line 100 ");
    expect(summary.length).toBeLessThan(2600);
  });

  test("long lines are truncated to 200 characters", () => {
    const longLine = "y".repeat(500);
    const summary = summarizeTranscript(longLine, 1000);
    expect(summary).toContain("y".repeat(200));
    expect(summary).not.toContain("y".repeat(201));
  });
});
