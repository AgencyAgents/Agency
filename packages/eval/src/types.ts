import type { ModelPricing } from "@agency/providers";

/** Roster under test. fixed is per-role routing, ladder climbs cheap to strong. */
export type RosterId = "solo" | "team" | "reviewer-first" | "fixed" | "ladder";

/** Task shape: single-file or multi-file coordination. */
export type EvalTaskKind = "single" | "multi";

/** One recorded task outcome. Paths are bare relative refs, never content. */
export interface EvalTaskRecord {
  taskId: string;
  kind: EvalTaskKind;
  filesTouched: string[];
  passed: boolean;
  /** Fractional score for a non-passing task, 0 when absent. */
  partialCredit?: number;
  usage: {
    inputTokens: number;
    outputTokens: number;
    cachedInputTokens?: number;
    cacheWriteInputTokens?: number;
  };
  wallClockMs: number;
  /** Merge failures plus overlapping path-scope writes. */
  conflicts: number;
}

/** Committed cassette: one roster configuration, fixed records, no timestamps. */
export interface EvalCassette {
  version: 1;
  roster: RosterId;
  promptVersion: string;
  pricing: ModelPricing;
  tasks: EvalTaskRecord[];
}

/** Per-configuration aggregates. Nulls mean no data, never zero-fill. */
export interface ConfigScore {
  roster: string;
  tasks: number;
  completed: number;
  passRate: number;
  costPerCompleted: number | null;
  totalUsd: number;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  cacheWriteInputTokens: number;
  cacheHitRate: number | null;
  conflicts: number;
  wallClockMs: number;
  promptVersion: string;
}

/** Baseline report. pending names configurations owned by later phases. */
export interface EvalReport {
  version: 1;
  promptVersion: string;
  scores: ConfigScore[];
  pending: { roster: string; mapsTo: string; owner: string }[];
}
