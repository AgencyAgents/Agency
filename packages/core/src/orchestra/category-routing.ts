/**
 * Category routing + delegate fallback (item 51).
 *
 * Maps a Boulder/dispatch task category to an optimized primary
 * provider+model+temperature, plus a cross-provider fallback chain so a
 * single provider outage never strands a delegate turn. Additive only:
 * existing dispatch/loop/daemon routing is untouched; callers opt in via
 * `routeForCategory` / `runWithCategoryFallback`.
 */

import { defaultModelIDs, type ModelInfo } from "@agency/providers";

/** Task categories the dispatcher recognizes. Unknown values normalize to `unspecified`. */
export type TaskCategory = "visual-engineering" | "ultrabrain" | "deep" | "quick" | "unspecified";

export const TASK_CATEGORIES: readonly TaskCategory[] = [
  "visual-engineering",
  "ultrabrain",
  "deep",
  "quick",
  "unspecified",
] as const;

/** One provider+model hop in a fallback chain. */
export interface CategoryModelRef {
  provider: string;
  model: string;
}

/** Full routing decision for a category: primary + temperature + cross-provider fallbacks. */
export interface CategoryRoute extends CategoryModelRef {
  category: TaskCategory;
  /** Sampling temperature optimized for the category (0 = deterministic). */
  temperature: number;
  /** Effort hint for thinking-capable models (mirrors EffortLevel vocabulary). */
  effort: "low" | "medium" | "high";
  /** Suggested per-request output cap for the category. */
  maxTokens: number;
  /** Ordered fallbacks AFTER the primary; every entry is a different provider. */
  fallback: CategoryModelRef[];
}

/**
 * Category -> primary model + temperature + cross-provider fallbacks.
 *
 * Primaries are chosen from the hand-maintained BUILTIN snapshot so the map
 * works offline; every chain spans at least 3 distinct provider families:
 *
 * - visual-engineering: vision+tools precision work -> low temperature.
 * - ultrabrain: hardest reasoning -> strongest model, higher temperature for
 *   divergent search, larger output cap.
 * - deep: thorough default-heavy work -> balanced temperature on a large-context model.
 * - quick: cheap fast path for trivial work -> cheapest thinking model first,
 *   then the other budget family, then a flagship as last resort.
 * - unspecified: safe balanced default for unclassified tasks.
 */
export const CATEGORY_ROUTES: Record<TaskCategory, CategoryRoute> = {
  "visual-engineering": {
    category: "visual-engineering",
    provider: "anthropic",
    model: "claude-sonnet-5",
    temperature: 0.2,
    effort: "medium",
    maxTokens: 8192,
    fallback: [
      { provider: "openai", model: "gpt-5.2" },
      { provider: "google", model: "gemini-3-pro" },
    ],
  },
  ultrabrain: {
    category: "ultrabrain",
    provider: "anthropic",
    model: "claude-opus-5",
    temperature: 0.7,
    effort: "high",
    maxTokens: 16384,
    fallback: [
      { provider: "openai", model: "gpt-5.2" },
      { provider: "google", model: "gemini-3-pro" },
    ],
  },
  deep: {
    category: "deep",
    provider: "openai",
    model: "gpt-5.2",
    temperature: 0.3,
    effort: "medium",
    maxTokens: 8192,
    fallback: [
      { provider: "anthropic", model: "claude-sonnet-5" },
      { provider: "google", model: "gemini-3-pro" },
    ],
  },
  quick: {
    category: "quick",
    provider: "deepseek",
    model: "deepseek-v4",
    temperature: 0.5,
    effort: "low",
    maxTokens: 4096,
    fallback: [
      { provider: "glm", model: "glm-7" },
      { provider: "openai", model: "gpt-5.2" },
    ],
  },
  unspecified: {
    category: "unspecified",
    provider: "anthropic",
    model: "claude-sonnet-5",
    temperature: 0.4,
    effort: "medium",
    maxTokens: 8192,
    fallback: [
      { provider: "openai", model: "gpt-5.2" },
      { provider: "google", model: "gemini-3-pro" },
    ],
  },
};

export function resolveCategoryRoutes(models: readonly ModelInfo[]): Record<TaskCategory, CategoryRoute> {
  const defaults = defaultModelIDs(models);
  const fix = (hop: CategoryModelRef): CategoryModelRef => {
    const fallback = defaults[hop.provider];
    if (!fallback) return hop;
    const pinned = models.some((m) => m.family === hop.provider && m.id === hop.model);
    return pinned ? hop : { provider: hop.provider, model: fallback };
  };
  const out = {} as Record<TaskCategory, CategoryRoute>;
  for (const [key, route] of Object.entries(CATEGORY_ROUTES) as Array<[TaskCategory, CategoryRoute]>) {
    const primary = fix(route);
    out[key] = {
      ...route,
      provider: primary.provider,
      model: primary.model,
      fallback: route.fallback.map(fix),
    };
  }
  return out;
}

/** Normalizes free-form input to a known category (case-insensitive, trimmed). */
export function normalizeCategory(raw: unknown): TaskCategory {
  if (typeof raw !== "string") return "unspecified";
  const t = raw.trim().toLowerCase();
  if ((TASK_CATEGORIES as readonly string[]).includes(t)) return t as TaskCategory;
  return "unspecified";
}

/** Routing decision for a category; returns a copy so callers cannot mutate the map. */
export function routeForCategory(category: unknown): CategoryRoute {
  const key = normalizeCategory(category);
  const route = CATEGORY_ROUTES[key] ?? CATEGORY_ROUTES.unspecified;
  return { ...route, fallback: route.fallback.map((f) => ({ ...f })) };
}

/** Ordered attempts for a category: primary first, then each fallback. */
export function fallbackChainFor(category: unknown): CategoryModelRef[] {
  const route = routeForCategory(category);
  return [{ provider: route.provider, model: route.model }, ...route.fallback];
}

/** Optimized temperature for a category. */
export function temperatureFor(category: unknown): number {
  return routeForCategory(category).temperature;
}

/**
 * Narrows a chain to the connected/allowed providers, preserving order.
 * Returns the full chain when nothing matches, so an offline or
 * misconfigured caller still attempts the primary instead of failing empty.
 */
export function filterChainByProviders(
  chain: readonly CategoryModelRef[],
  available: Iterable<string> | undefined,
): CategoryModelRef[] {
  if (!available) return [...chain];
  const allowed = new Set([...available].map((p) => p.toLowerCase()));
  const kept = chain.filter((hop) => allowed.has(hop.provider.toLowerCase()));
  return kept.length > 0 ? kept : [...chain];
}

export interface CategoryAttempt extends CategoryModelRef {
  /** Sampling temperature for the category (same for every attempt). */
  temperature: number;
  /** 0-based index into the chain. */
  attempt: number;
  /** Total attempts in the chain. */
  attempts: number;
}

export interface CategoryFallbackOptions {
  /** When set, hops outside this provider set are skipped (order preserved). */
  availableProviders?: Iterable<string>;
}

/**
 * Resilient delegate runner: tries each hop in the category chain in order
 * until `fn` resolves. Rejects with an aggregate error naming every
 * attempted `provider/model` pair when the chain is exhausted. `fn` receives
 * the hop plus temperature/attempt metadata so model calls need no extra lookup.
 */
export async function runWithCategoryFallback<T>(
  category: unknown,
  fn: (attempt: CategoryAttempt) => Promise<T>,
  opts: CategoryFallbackOptions = {},
): Promise<T> {
  const route = routeForCategory(category);
  const chain = filterChainByProviders(fallbackChainFor(route.category), opts.availableProviders);
  const errors: unknown[] = [];
  for (let i = 0; i < chain.length; i++) {
    const hop = chain.at(i);
    if (!hop) continue;
    try {
      return await fn({
        provider: hop.provider,
        model: hop.model,
        temperature: route.temperature,
        attempt: i,
        attempts: chain.length,
      });
    } catch (error) {
      errors.push(error);
    }
  }
  const tried = chain.map((h) => `${h.provider}/${h.model}`).join(", ");
  throw new Error(`category "${route.category}" fallback chain exhausted (${tried})`, { cause: errors });
}
