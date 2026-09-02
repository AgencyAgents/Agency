import type { SessionStore } from "@agency/core";
import type { ModelPricing, Usage } from "@agency/providers";

/**
 * Per-session cost/token accounting (P8): accumulates turn usage, computes
 * cost from the model's per-MTok pricing, and reports the prompt-cache hit
 * rate so users can see the harness being economical rather than take it on
 * faith. `cachedInputTokens` is optional on Usage — providers that don't
 * report it simply contribute no cache data, and the hit rate stays undefined
 * instead of pretending zero.
 */

export interface UsageTurn {
  usage: Usage;
  /** Model id, for pricing lookup and display. */
  model: string;
  pricing?: ModelPricing;
}

export interface SessionUsageTotals {
  turns: number;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  /** USD, from per-MTok pricing; 0 when no pricing was supplied. */
  costUsd: number;
  /** 0..1, or undefined when no turn reported cached tokens. */
  cacheHitRate: number | undefined;
}

export function cacheHitRate(usage: Usage): number | undefined {
  if (usage.cachedInputTokens === undefined) return undefined;
  if (usage.inputTokens <= 0) return usage.cachedInputTokens > 0 ? 1 : undefined;
  return Math.min(usage.cachedInputTokens / usage.inputTokens, 1);
}

export function turnCostUsd(usage: Usage, pricing?: ModelPricing): number {
  if (!pricing) return 0;
  const cached = usage.cachedInputTokens ?? 0;
  const uncachedInput = Math.max(usage.inputTokens - cached, 0);
  const cachedRate = pricing.cachedInputPerMTok ?? pricing.inputPerMTok;
  return (
    (uncachedInput / 1_000_000) * pricing.inputPerMTok +
    (cached / 1_000_000) * cachedRate +
    (usage.outputTokens / 1_000_000) * pricing.outputPerMTok
  );
}

/** The persisted session entry (R5: additive type, unknown-entry passthrough
 *  keeps older readers working). */
export interface UsageSessionEntry {
  type: "usage";
  model: string;
  usage: Usage;
  costUsd: number;
  cacheHitRate: number | undefined;
}

export function usageEntry(turn: UsageTurn): UsageSessionEntry {
  return {
    type: "usage",
    model: turn.model,
    usage: turn.usage,
    costUsd: turnCostUsd(turn.usage, turn.pricing),
    cacheHitRate: cacheHitRate(turn.usage),
  };
}

export function isUsageEntry(entry: { type: string }): entry is { type: "usage" } & UsageSessionEntry {
  return entry.type === "usage";
}

/** Appends one turn's usage as a session entry, chained after `parentId`.
 *  Returns the new entry id so callers can keep the branch tip moving. */
export async function appendUsageEntry(
  store: SessionStore,
  sessionId: string,
  parentId: string | null,
  turn: UsageTurn,
): Promise<string> {
  return (await store.append(sessionId, { parentId, ...usageEntry(turn) })).id;
}

/** Accumulates a session's turns in memory and totals them on demand. */
export class SessionUsageTracker {
  private readonly turns: UsageTurn[] = [];

  addTurn(turn: UsageTurn): void {
    this.turns.push(turn);
  }

  summary(): SessionUsageTotals {
    let inputTokens = 0;
    let outputTokens = 0;
    let cachedInputTokens = 0;
    let costUsd = 0;
    let sawCacheData = false;

    for (const turn of this.turns) {
      inputTokens += turn.usage.inputTokens;
      outputTokens += turn.usage.outputTokens;
      if (turn.usage.cachedInputTokens !== undefined) {
        cachedInputTokens += turn.usage.cachedInputTokens;
        sawCacheData = true;
      }
      costUsd += turnCostUsd(turn.usage, turn.pricing);
    }

    return {
      turns: this.turns.length,
      inputTokens,
      outputTokens,
      cachedInputTokens,
      costUsd,
      cacheHitRate: sawCacheData && inputTokens > 0 ? cachedInputTokens / inputTokens : undefined,
    };
  }
}

export function formatCostUsd(cost: number): string {
  if (cost === 0) return "$0.00";
  if (cost < 0.01) return `$${cost.toFixed(4)}`;
  return `$${cost.toFixed(2)}`;
}

export function formatCacheHitRate(rate: number | undefined): string {
  if (rate === undefined) return "n/a";
  return `${Math.round(rate * 100)}%`;
}
