import type { ThinkingLevel } from "./types.ts";
import type { ModelInfo } from "./registry.ts";

export const EFFORT_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max", "auto"] as const;
export type EffortLevel = (typeof EFFORT_LEVELS)[number];

const ANTHROPIC_BUDGET: Record<Exclude<ThinkingLevel, "off">, number> = {
  minimal: 1024,
  low: 2048,
  medium: 4096,
  high: 8192,
  xhigh: 16384,
  max: 32000,
};

const OPENAI_EFFORT: Record<Exclude<ThinkingLevel, "off">, string> = {
  minimal: "minimal",
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "high",
  max: "high",
};

const GOOGLE_BUDGET: Record<ThinkingLevel, number> = {
  off: 0,
  minimal: 512,
  low: 2048,
  medium: 8192,
  high: 16384,
  xhigh: 24576,
  max: -1,
};

export function effortToThinkingLevel(effort: EffortLevel, fallback: ThinkingLevel = "medium"): ThinkingLevel {
  if (effort === "auto") return fallback;
  return effort as ThinkingLevel;
}

export function resolveThinkingLevelForModel(
  level: ThinkingLevel,
  model?: ModelInfo,
): { thinkingLevel: ThinkingLevel; mapping: unknown } {
  if (!model?.effortMapping) {
    return { thinkingLevel: level, mapping: undefined };
  }
  const mapped = model.effortMapping[level];
  return { thinkingLevel: level, mapping: mapped };
}

export function anthropicBudget(level: ThinkingLevel): number | undefined {
  if (level === "off") return undefined;
  return ANTHROPIC_BUDGET[level];
}

export function openaiEffort(level: ThinkingLevel): string | undefined {
  if (level === "off") return undefined;
  return OPENAI_EFFORT[level];
}

export function googleBudget(level: ThinkingLevel): number {
  return GOOGLE_BUDGET[level];
}

export function classifyEffortFromText(text: string): ThinkingLevel {
  const t = text.toLowerCase();
  if (t.includes("trivial") || t.includes("typo") || t.length < 20) return "low";
  if (t.includes("complex") || t.includes("architecture") || t.includes("design") || t.includes("plan")) return "high";
  if (t.includes("review") || t.includes("audit")) return "medium";
  return "medium";
}
