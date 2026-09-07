import { PROMPT_VERSION } from "@agency/core";
import { turnCostUsd } from "@agency/telemetry";
import type { ConfigScore, EvalCassette, EvalReport } from "./types.ts";

/** Score one cassette. Pure over records, so replay and report agree. */
export function scoreCassette(cassette: EvalCassette): ConfigScore {
  let completed = 0;
  let creditSum = 0;
  let totalUsd = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let cachedInputTokens = 0;
  let cacheWriteInputTokens = 0;
  let sawCacheData = false;
  let conflicts = 0;
  let wallClockMs = 0;
  for (const task of cassette.tasks) {
    if (task.passed) completed += 1;
    creditSum += task.passed ? 1 : (task.partialCredit ?? 0);
    totalUsd += turnCostUsd(task.usage, cassette.pricing);
    inputTokens += task.usage.inputTokens;
    outputTokens += task.usage.outputTokens;
    if (task.usage.cachedInputTokens !== undefined) {
      cachedInputTokens += task.usage.cachedInputTokens;
      sawCacheData = true;
    }
    if (task.usage.cacheWriteInputTokens !== undefined) {
      cacheWriteInputTokens += task.usage.cacheWriteInputTokens;
      sawCacheData = true;
    }
    conflicts += task.conflicts;
    wallClockMs += task.wallClockMs;
  }
  const tasks = cassette.tasks.length;
  return {
    roster: cassette.roster,
    tasks,
    completed,
    passRate: tasks === 0 ? 0 : creditSum / tasks,
    costPerCompleted: completed === 0 ? null : totalUsd / completed,
    totalUsd,
    inputTokens,
    outputTokens,
    cachedInputTokens,
    cacheWriteInputTokens,
    cacheHitRate: sawCacheData && inputTokens > 0 ? cachedInputTokens / inputTokens : null,
    conflicts,
    wallClockMs,
    promptVersion: cassette.promptVersion,
  };
}

/** Assemble the baseline report, stamped with the live PROMPT_VERSION. */
export function scoreReport(cassettes: EvalCassette[]): EvalReport {
  return {
    version: 1,
    promptVersion: PROMPT_VERSION,
    scores: cassettes.map(scoreCassette),
    pending: [],
  };
}
