import { describe, expect, test } from "bun:test";
import { compactionPrompt } from "../../src/prompt/compaction.ts";

describe("compactionPrompt", () => {
  test("returns a non-empty string", () => {
    const prompt = compactionPrompt();
    expect(prompt.length).toBeGreaterThan(0);
  });

  test("identifies as a session summarizer role", () => {
    const prompt = compactionPrompt();
    expect(prompt.toLowerCase()).toContain("summariz");
  });

  test("denies all tools - tools are listed as none", () => {
    const prompt = compactionPrompt();
    expect(prompt).toContain("Tools: none");
  });

  test("instructs to preserve todo_state entries verbatim", () => {
    const prompt = compactionPrompt();
    expect(prompt).toContain("todo_state");
    expect(prompt).toContain("verbatim");
  });

  test("instructs to preserve recent assistant texts verbatim", () => {
    const prompt = compactionPrompt();
    expect(prompt).toContain("assistant");
    expect(prompt).toMatch(/(last|recent)\s.*\b(text|message|response)/i);
  });

  test("has a structured output contract", () => {
    const prompt = compactionPrompt();
    expect(prompt).toContain("Output contract");
    expect(prompt).toContain("[Compacted:");
  });

  test("step-4 cap is per-chunk guidance with harness 20K total", () => {
    const prompt = compactionPrompt();
    expect(prompt).toContain("Keep this chunk under 4000 tokens");
    expect(prompt).toContain("20K");
  });
});
