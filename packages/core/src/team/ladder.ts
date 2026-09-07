import { BUILTIN_MODELS } from "@agency/providers";
import { type CategoryModelRef, fallbackChainFor, filterChainByProviders } from "./category-routing.ts";

// Global cheap-to-strong rungs. Items start at rung 0 and climb
// one rung per bounce or decline, carrying failure notes upward.
export const MODEL_LADDER: readonly CategoryModelRef[] = [
  { provider: "deepseek", model: "deepseek-v4" },
  { provider: "glm", model: "glm-7" },
  { provider: "google", model: "gemini-3-pro" },
  { provider: "openai", model: "gpt-5.2" },
  { provider: "anthropic", model: "claude-sonnet-5" },
  { provider: "anthropic", model: "claude-opus-5" },
];

function builtinInputPrice(provider: string, model: string): number {
  const found = BUILTIN_MODELS.find((m) => m.family === provider && m.id === model);
  return found?.pricing.inputPerMTok ?? Number.MAX_SAFE_INTEGER;
}

// The category fallback chain is the ladder's chain selector:
// order cheap-first by catalog input price so expensive models only
// ever see work cheap models could not close.
export function resolveLadderChain(opts: {
  category?: unknown;
  availableProviders?: Iterable<string>;
}): CategoryModelRef[] {
  const base = opts.category === undefined ? [...MODEL_LADDER] : fallbackChainFor(opts.category);
  const filtered = filterChainByProviders(base, opts.availableProviders);
  return [...filtered].sort(
    (a, b) => builtinInputPrice(a.provider, a.model) - builtinInputPrice(b.provider, b.model),
  );
}

export interface LadderState {
  ladderRung?: number;
  failureNotes?: string[];
  provider?: string;
  model?: string;
}

// One bounce or decline climbs exactly one rung and keeps the note,
// so the next model sees why the cheaper one failed.
export function climbLadder<T extends LadderState>(
  item: T,
  note: string,
  chain: readonly CategoryModelRef[],
): T & { rung: CategoryModelRef } {
  const rung = Math.min((item.ladderRung ?? 0) + 1, Math.max(0, chain.length - 1));
  const hop = chain[rung] ?? chain[0];
  if (!hop) throw new Error("resolveLadderChain returned no rungs");
  return {
    ...item,
    ladderRung: rung,
    failureNotes: [...(item.failureNotes ?? []), note],
    provider: hop.provider,
    model: hop.model,
    rung: hop,
  };
}

export function ladderHopFor<T extends LadderState>(
  item: T,
  chain: readonly CategoryModelRef[],
): CategoryModelRef {
  const hop = chain[item.ladderRung ?? 0] ?? chain[0];
  if (!hop) throw new Error("resolveLadderChain returned no rungs");
  return hop;
}

// Cross-provider retry: the next rung on a different family,
// so a provider outage never strands the item on the same vendor.
export function retryTarget<T extends LadderState>(
  item: T,
  chain: readonly CategoryModelRef[],
): (CategoryModelRef & { rung: number }) | undefined {
  const from = item.ladderRung ?? 0;
  for (let rung = from + 1; rung < chain.length; rung++) {
    const hop = chain[rung];
    if (hop && hop.provider !== item.provider) return { ...hop, rung };
  }
  const firstOther = chain.find((hop) => hop.provider !== item.provider);
  return firstOther ? { ...firstOther, rung: chain.indexOf(firstOther) } : undefined;
}
