import { describe, expect, test } from "bun:test";
import { titlePrompt } from "../../src/prompt/title.ts";

describe("titlePrompt", () => {
  test("returns a non-empty string", () => {
    const prompt = titlePrompt();
    expect(prompt.length).toBeGreaterThan(0);
  });

  test("constrains output to a single line", () => {
    const prompt = titlePrompt();
    expect(prompt).toContain("single line");
    expect(prompt).toContain("50");
  });

  test("constrains output to 50 characters or fewer", () => {
    const prompt = titlePrompt();
    expect(prompt).toMatch(/50/);
    expect(prompt).toMatch(/char/);
    expect(prompt).toMatch(/line/);
  });

  test("does not pin temperature (caller responsibility)", () => {
    const prompt = titlePrompt();
    expect(prompt).not.toMatch(/temperature/i);
  });
});
