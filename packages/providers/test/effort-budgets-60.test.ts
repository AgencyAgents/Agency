import { describe, expect, test } from "bun:test";
import {
  anthropicBudget,
  deepseekBudget,
  glmBudget,
  googleBudget,
  openaiEffort,
} from "../src/effort-mapping.ts";

describe("item 60: provider-specific thinking budgets per family", () => {
  test("anthropic budgets match the adapter table, off omits", () => {
    expect(anthropicBudget("off")).toBeUndefined();
    expect(anthropicBudget("minimal")).toBe(1024);
    expect(anthropicBudget("low")).toBe(2048);
    expect(anthropicBudget("medium")).toBe(4096);
    expect(anthropicBudget("high")).toBe(8192);
    expect(anthropicBudget("xhigh")).toBe(16384);
    expect(anthropicBudget("max")).toBe(32000);
  });

  test("openai effort compresses xhigh/max onto high, off omits", () => {
    expect(openaiEffort("off")).toBeUndefined();
    expect(openaiEffort("minimal")).toBe("minimal");
    expect(openaiEffort("low")).toBe("low");
    expect(openaiEffort("medium")).toBe("medium");
    expect(openaiEffort("high")).toBe("high");
    expect(openaiEffort("xhigh")).toBe("high");
    expect(openaiEffort("max")).toBe("high");
  });

  test("google budgets include off=0 and max=-1 (model decides)", () => {
    expect(googleBudget("off")).toBe(0);
    expect(googleBudget("minimal")).toBe(512);
    expect(googleBudget("low")).toBe(2048);
    expect(googleBudget("medium")).toBe(8192);
    expect(googleBudget("high")).toBe(16384);
    expect(googleBudget("xhigh")).toBe(24576);
    expect(googleBudget("max")).toBe(-1);
  });

  test("deepseek budgets cap xhigh at 8192, off omits", () => {
    expect(deepseekBudget("off")).toBeUndefined();
    expect(deepseekBudget("minimal")).toBe(1024);
    expect(deepseekBudget("low")).toBe(2048);
    expect(deepseekBudget("medium")).toBe(4096);
    expect(deepseekBudget("high")).toBe(8192);
    expect(deepseekBudget("xhigh")).toBe(8192);
    expect(deepseekBudget("max")).toBe(16384);
  });

  test("glm budgets cap high/xhigh/max at 8192, off omits", () => {
    expect(glmBudget("off")).toBeUndefined();
    expect(glmBudget("minimal")).toBe(1024);
    expect(glmBudget("low")).toBe(2048);
    expect(glmBudget("medium")).toBe(4096);
    expect(glmBudget("high")).toBe(8192);
    expect(glmBudget("xhigh")).toBe(8192);
    expect(glmBudget("max")).toBe(8192);
  });
});
