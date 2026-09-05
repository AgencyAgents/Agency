import { describe, expect, test } from "bun:test";
import { summaryPrompt } from "../../src/prompt/summary.ts";

describe("summaryPrompt", () => {
  test("returns a non-empty string", () => {
    const prompt = summaryPrompt();
    expect(prompt.length).toBeGreaterThan(0);
  });

  test("identifies as a summarizer role", () => {
    const prompt = summaryPrompt();
    expect(prompt.toLowerCase()).toContain("summar");
  });

  test("requests a concise summary with key decisions and outcomes", () => {
    const prompt = summaryPrompt();
    expect(prompt).toMatch(/key\s.*(decision|outcome|point)/i);
    expect(prompt).toMatch(/concise|brief|short/i);
  });
});
