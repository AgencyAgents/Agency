import type { ModelInfo } from "./registry.ts";
import type { ThinkingLevel } from "./types.ts";

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

const DEEPSEEK_BUDGET: Record<Exclude<ThinkingLevel, "off">, number> = {
  minimal: 1024,
  low: 2048,
  medium: 4096,
  high: 8192,
  xhigh: 8192,
  max: 16384,
};

const GLM_BUDGET: Record<Exclude<ThinkingLevel, "off">, number> = {
  minimal: 1024,
  low: 2048,
  medium: 4096,
  high: 8192,
  xhigh: 8192,
  max: 8192,
};

/**
 * Returns the set of effort levels a given model actually supports.
 *
 * - Unknown model (not in catalog) → all `EFFORT_LEVELS` (preserve whatever the user set).
 * - `capabilities.thinking === false` → `["off"]` (single option, no variable reasoning).
 * - Thinking-capable model with `effortMapping` → the mapping's keys that are valid EffortLevel values,
 *   plus `"auto"` (variable reasoning is present).
 * - Thinking-capable model without `effortMapping` → all `EFFORT_LEVELS` (full variable support as fallback).
 */
export function supportedEffortsForModel(model?: ModelInfo): EffortLevel[] {
  if (!model) {
    // Unknown model (not in catalog) — assume full capability so clamping preserves the user's choice
    return [...EFFORT_LEVELS];
  }
  if (!model.capabilities.thinking) {
    return ["off"];
  }
  if (model.effortMapping) {
    const keys = Object.keys(model.effortMapping).filter(
      (k): k is EffortLevel => (EFFORT_LEVELS as readonly string[]).includes(k) && k !== "auto",
    );
    // Deduplicate and sort by EFFORT_LEVELS order, then append "auto"
    const seen = new Set<EffortLevel>();
    const ordered: EffortLevel[] = [];
    for (const level of EFFORT_LEVELS) {
      if (level === "auto") continue; // appended at the end
      if (keys.includes(level) && !seen.has(level)) {
        seen.add(level);
        ordered.push(level);
      }
    }
    ordered.push("auto");
    return ordered;
  }
  // thinking-capable but no explicit mapping → full range
  return [...EFFORT_LEVELS];
}

/**
 * Clamps an effort level to the nearest supported level for the given model.
 * Never rejects — always returns a valid EffortLevel the model can use.
 */
export function clampEffortForModel(effort: EffortLevel, model?: ModelInfo): EffortLevel {
  const supported = supportedEffortsForModel(model);
  if (supported.includes(effort)) return effort;

  // "auto" on a model without variable reasoning → nearest fixed level
  if (effort === "auto") {
    // Prefer "off" when model can't think, otherwise the highest supported
    return supported.includes("off") ? "off" : supported[supported.length - 1]!;
  }

  // Find nearest by index in EFFORT_LEVELS order
  const targetIdx = EFFORT_LEVELS.indexOf(effort);
  if (targetIdx === -1) return supported[0]!; // shouldn't happen, but be safe

  let best = supported[0]!;
  let bestDist = Infinity;
  for (const s of supported) {
    const sIdx = EFFORT_LEVELS.indexOf(s);
    if (sIdx === -1) continue;
    const dist = Math.abs(sIdx - targetIdx);
    if (dist < bestDist) {
      bestDist = dist;
      best = s;
    }
  }
  return best;
}

export function effortToThinkingLevel(
  effort: EffortLevel,
  fallback: ThinkingLevel = "medium",
): ThinkingLevel {
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

export function deepseekBudget(level: ThinkingLevel): number | undefined {
  if (level === "off") return undefined;
  return DEEPSEEK_BUDGET[level];
}

export function glmBudget(level: ThinkingLevel): number | undefined {
  if (level === "off") return undefined;
  return GLM_BUDGET[level];
}

export function classifyEffortFromText(text: string): ThinkingLevel {
  const t = text.toLowerCase();
  if (t.includes("trivial") || t.includes("typo") || t.length < 20) return "low";
  if (t.includes("complex") || t.includes("architecture") || t.includes("design") || t.includes("plan"))
    return "high";
  if (t.includes("review") || t.includes("audit")) return "medium";
  return "medium";
}
