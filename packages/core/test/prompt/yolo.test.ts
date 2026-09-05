import { describe, expect, test } from "bun:test";
import { yoloPrompt } from "../../src/prompt/yolo.ts";

describe("yoloPrompt", () => {
  test("returns a non-empty string", () => {
    const prompt = yoloPrompt();
    expect(prompt.length).toBeGreaterThan(0);
  });

  test("identifies as a background worker", () => {
    const prompt = yoloPrompt();
    expect(prompt.toLowerCase()).toContain("background");
  });

  test("requires ending with a completion tool call", () => {
    const prompt = yoloPrompt();
    expect(prompt).toContain("completion");
    expect(prompt).toContain("end");
  });

  test("states that the worker runs headless without user interaction", () => {
    const prompt = yoloPrompt();
    expect(prompt.toLowerCase()).toContain("headless");
    expect(prompt).toMatch(/(without|no)\s.*(user|interact)/i);
  });
});
