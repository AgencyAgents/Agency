import { describe, expect, test } from "bun:test";
import {
  clampEffortForModel,
  classifyEffortFromText,
  EFFORT_LEVELS,
  supportedEffortsForModel,
} from "../src/effort-mapping.ts";
import type { ModelInfo } from "../src/registry.ts";

const noThinkingModel: ModelInfo = {
  id: "glm-7",
  family: "glm",
  contextWindow: 128_000,
  maxOutputTokens: 16_384,
  pricing: { inputPerMTok: 0.3, outputPerMTok: 1.2 },
  capabilities: { tools: true, vision: true, thinking: false },
};

const thinkingNoMappingModel: ModelInfo = {
  id: "claude-sonnet-5",
  family: "anthropic",
  contextWindow: 200_000,
  maxOutputTokens: 64_000,
  pricing: { inputPerMTok: 3, outputPerMTok: 15, cachedInputPerMTok: 0.3 },
  capabilities: { tools: true, vision: true, thinking: true },
};

const thinkingWithMappingModel: ModelInfo = {
  id: "gpt-5.2",
  family: "openai",
  contextWindow: 400_000,
  maxOutputTokens: 128_000,
  pricing: { inputPerMTok: 5, outputPerMTok: 20, cachedInputPerMTok: 1.25 },
  capabilities: { tools: true, vision: true, thinking: true },
  effortMapping: {
    off: undefined,
    minimal: "minimal",
    low: "low",
    medium: "medium",
    high: "high",
    max: "high",
  },
};

describe("supportedEffortsForModel", () => {
  test("returns full EFFORT_LEVELS when model is undefined (unknown model)", () => {
    expect(supportedEffortsForModel(undefined)).toEqual([...EFFORT_LEVELS]);
  });

  test("returns ['off'] when capabilities.thinking is false", () => {
    expect(supportedEffortsForModel(noThinkingModel)).toEqual(["off"]);
  });

  test("returns full EFFORT_LEVELS when thinking is true but no effortMapping", () => {
    const result = supportedEffortsForModel(thinkingNoMappingModel);
    expect(result).toEqual([...EFFORT_LEVELS]);
  });

  test("returns mapping keys plus auto when thinking is true with effortMapping", () => {
    const result = supportedEffortsForModel(thinkingWithMappingModel);
    // off, minimal, low, medium, high, max are in mapping; xhigh is not; auto appended
    expect(result).toEqual(["off", "minimal", "low", "medium", "high", "max", "auto"]);
    expect(result).not.toContain("xhigh");
  });

  test("returns only mapping keys that are valid EffortLevel values", () => {
    const model: ModelInfo = {
      ...thinkingWithMappingModel,
      effortMapping: { off: undefined, low: "low", unknown_key: "foo" },
    };
    const result = supportedEffortsForModel(model);
    expect(result).toContain("off");
    expect(result).toContain("low");
    expect(result).not.toContain("unknown_key");
    expect(result).toContain("auto");
  });
});

describe("clampEffortForModel", () => {
  test("passes through supported effort unchanged", () => {
    expect(clampEffortForModel("off", noThinkingModel)).toBe("off");
    expect(clampEffortForModel("high", thinkingNoMappingModel)).toBe("high");
  });

  test("clamps 'auto' to 'off' when model has no thinking", () => {
    expect(clampEffortForModel("auto", noThinkingModel)).toBe("off");
  });

  test("clamps 'auto' to highest supported when model thinks but has limited mapping", () => {
    const limitedModel: ModelInfo = {
      ...thinkingWithMappingModel,
      effortMapping: { off: undefined, low: "low", medium: "medium" },
    };
    // "auto" is supported because thinking=true, so it passes through
    const result = clampEffortForModel("auto", limitedModel);
    expect(result).toBe("auto");
  });

  test("clamps unsupported effort to nearest supported by index", () => {
    const limitedModel: ModelInfo = {
      ...thinkingWithMappingModel,
      effortMapping: { off: undefined, low: "low", max: "high" },
    };
    // EFFORT_LEVELS indices: off=0, minimal=1, low=2, medium=3, high=4, xhigh=5, max=6
    // Supported: off(0), low(2), max(6), auto
    // "high"(4) -> nearest is max(6) dist 2 or low(2) dist 2 -> low encountered first
    const result = clampEffortForModel("high", limitedModel);
    expect(result).toBe("low");
  });

  test("clamps unsupported effort to first supported when no clear nearest", () => {
    const model: ModelInfo = {
      ...thinkingWithMappingModel,
      effortMapping: { off: undefined },
    };
    // Supported: off(0), auto(7). "high"(4) -> nearest is auto (dist 3 vs 4)
    expect(clampEffortForModel("high", model)).toBe("auto");
  });

  test("passes through effort unchanged for unknown model (undefined)", () => {
    expect(clampEffortForModel("high", undefined)).toBe("high");
    expect(clampEffortForModel("auto", undefined)).toBe("auto");
  });
});

describe("classifyEffortFromText", () => {
  test("short text returns low", () => {
    expect(classifyEffortFromText("hi")).toBe("low");
  });

  test("typo-related text returns low", () => {
    expect(classifyEffortFromText("fix typo in welcome message")).toBe("low");
  });

  test("trivial task returns low", () => {
    expect(classifyEffortFromText("trivial formatting change")).toBe("low");
  });

  test("complex task returns high", () => {
    expect(classifyEffortFromText("complex refactoring of the architecture")).toBe("high");
  });

  test("planning task returns high", () => {
    expect(classifyEffortFromText("design the new API architecture plan")).toBe("high");
  });

  test("review task returns medium", () => {
    expect(classifyEffortFromText("review the pull request code")).toBe("medium");
  });

  test("audit task returns medium", () => {
    expect(classifyEffortFromText("audit the security dependencies")).toBe("medium");
  });

  test("default non-matching text returns medium", () => {
    expect(classifyEffortFromText("update the readme with new instructions")).toBe("medium");
  });
});
