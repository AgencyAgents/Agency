import type { HttpClient } from "@agency/net";

export interface ModelPricing {
  /** USD per million input tokens. */
  inputPerMTok: number;
  /** USD per million output tokens. */
  outputPerMTok: number;
  /** USD per million cache-hit input tokens, when the family supports caching. */
  cachedInputPerMTok?: number;
}

export interface ModelCapabilities {
  tools: boolean;
  vision: boolean;
  thinking: boolean;
}

/** Lifecycle stage from the catalog; deprecated models are hidden by default. */
export type ModelStatus = "alpha" | "beta" | "deprecated" | "active";

export interface ModelInfo {
  id: string;
  family: string;
  /** Human display name from the catalog ("Claude Opus 5"). */
  name?: string;
  /** Display name of the owning provider ("Anthropic"), for picker grouping. */
  providerName?: string;
  contextWindow: number;
  maxOutputTokens: number;
  pricing: ModelPricing;
  capabilities: ModelCapabilities;
  status?: ModelStatus;
  /** ISO date (YYYY-MM-DD) the provider shipped the model, newest sorts first. */
  releaseDate?: string;
  /** Raw input modality list from the catalog (text/image/audio/video/pdf). */
  inputModalities?: string[];
  /** Provider API base URL from the catalog, for gateway-style providers. */
  apiBaseURL?: string;
  /** The client package that knows how to talk to this provider. */
  apiNpm?: string;
  /** Per-model effort-to-provider knob mapping. Absent = model has no variable reasoning. */
  effortMapping?: Record<string, unknown>;
}

/**
 * A small, hand-maintained snapshot: provider catalogs move fast enough that
 * this is a starting point, not a source of truth. It doubles as the offline
 * fallback when the models.dev catalog has never been fetched (opencode's
 * build-time snapshot role), and `refresh()` reconciles it against each
 * family's live models endpoint.
 */
export const BUILTIN_MODELS: ModelInfo[] = [
  {
    id: "claude-opus-5",
    family: "anthropic",
    name: "Claude Opus 5",
    providerName: "Anthropic",
    contextWindow: 200_000,
    maxOutputTokens: 32_000,
    pricing: { inputPerMTok: 15, outputPerMTok: 75, cachedInputPerMTok: 1.5 },
    capabilities: { tools: true, vision: true, thinking: true },
    releaseDate: "2026-05-01",
  },
  {
    id: "claude-sonnet-5",
    family: "anthropic",
    name: "Claude Sonnet 5",
    providerName: "Anthropic",
    contextWindow: 200_000,
    maxOutputTokens: 64_000,
    pricing: { inputPerMTok: 3, outputPerMTok: 15, cachedInputPerMTok: 0.3 },
    capabilities: { tools: true, vision: true, thinking: true },
    releaseDate: "2026-02-01",
  },
  {
    id: "gpt-5.2",
    family: "openai",
    name: "GPT-5.2",
    providerName: "OpenAI",
    contextWindow: 400_000,
    maxOutputTokens: 128_000,
    pricing: { inputPerMTok: 5, outputPerMTok: 20, cachedInputPerMTok: 1.25 },
    capabilities: { tools: true, vision: true, thinking: true },
    releaseDate: "2026-04-01",
  },
  {
    id: "gemini-3-pro",
    family: "google",
    name: "Gemini 3 Pro",
    providerName: "Google",
    contextWindow: 1_000_000,
    maxOutputTokens: 65_536,
    pricing: { inputPerMTok: 2.5, outputPerMTok: 10 },
    capabilities: { tools: true, vision: true, thinking: true },
    releaseDate: "2026-03-01",
  },
  {
    id: "deepseek-v4",
    family: "deepseek",
    name: "DeepSeek V4",
    providerName: "DeepSeek",
    contextWindow: 128_000,
    maxOutputTokens: 32_000,
    pricing: { inputPerMTok: 0.5, outputPerMTok: 2 },
    capabilities: { tools: true, vision: false, thinking: true },
    releaseDate: "2026-06-01",
  },
  {
    id: "glm-7",
    family: "glm",
    name: "GLM-7",
    providerName: "Zhipu AI",
    contextWindow: 128_000,
    maxOutputTokens: 16_384,
    pricing: { inputPerMTok: 0.3, outputPerMTok: 1.2 },
    capabilities: { tools: true, vision: true, thinking: false },
    releaseDate: "2026-05-15",
  },
];

/**
 * Sort derived from the catalog itself: newest releaseDate first, then id
 * descending as a stable tiebreaker. No hardcoded priority prefixes — the
 * default-model heuristic is `defaultModelIDs` over this same ordering, so
 * sort, picker, and routing can never drift apart.
 */

function releaseTime(model: ModelInfo): number {
  if (!model.releaseDate) return 0;
  const time = new Date(model.releaseDate).getTime();
  return Number.isNaN(time) ? 0 : time;
}

export function sortModels(models: readonly ModelInfo[]): ModelInfo[] {
  return [...models].sort((a, b) => {
    const release = releaseTime(b) - releaseTime(a);
    if (release !== 0) return release;
    return b.id.localeCompare(a.id);
  });
}

/** The best model id per provider family, by the same ordering as `sortModels`. */
export function defaultModelIDs(models: readonly ModelInfo[]): Record<string, string> {
  const byFamily = new Map<string, ModelInfo[]>();
  for (const model of models) {
    const family = byFamily.get(model.family) ?? [];
    family.push(model);
    byFamily.set(model.family, family);
  }
  const out: Record<string, string> = {};
  for (const [family, familyModels] of byFamily) {
    const best = sortModels(familyModels)[0];
    if (best) out[family] = best.id;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Config merge: user config states deltas over the catalog, never the whole
// model. A known provider id inherits everything it doesn't override; a new
// id becomes a first-class provider from its `models` entries alone.
// ---------------------------------------------------------------------------

/** One model entry from config `provider.<id>.models`; every field optional. */
export interface ModelOverride {
  name?: string;
  contextWindow?: number;
  maxOutputTokens?: number;
  pricing?: Partial<ModelPricing>;
  capabilities?: Partial<ModelCapabilities>;
  status?: ModelStatus;
  releaseDate?: string;
}

/** One provider entry from config `provider.<id>`. */
export interface ProviderOverride {
  name?: string;
  models?: Record<string, ModelOverride>;
  whitelist?: string[];
  blacklist?: string[];
}

function mergeModel(base: ModelInfo, override: ModelOverride, family: string): ModelInfo {
  return {
    ...base,
    family,
    name: override.name ?? base.name,
    contextWindow: override.contextWindow ?? base.contextWindow,
    maxOutputTokens: override.maxOutputTokens ?? base.maxOutputTokens,
    pricing: { ...base.pricing, ...override.pricing },
    capabilities: { ...base.capabilities, ...override.capabilities },
    status: override.status ?? base.status,
    releaseDate: override.releaseDate ?? base.releaseDate,
  };
}

function bareModel(id: string, family: string, override: ModelOverride): ModelInfo {
  return mergeModel(
    {
      id,
      family,
      contextWindow: 0,
      maxOutputTokens: 0,
      pricing: { inputPerMTok: 0, outputPerMTok: 0 },
      capabilities: { tools: false, vision: false, thinking: false },
    },
    override,
    family,
  );
}

/**
 * Merges config provider entries over the catalog. For a provider the catalog
 * knows, each config model overrides only the fields it states and inherits
 * the rest (name, pricing, limits) from the catalog entry; unknown model ids
 * under a known provider are added. For a provider the catalog doesn't know,
 * its `models` entries alone define it, so a custom gateway needs nothing
 * else to appear in the picker.
 */
export function mergeCatalogWithConfig(
  catalog: readonly ModelInfo[],
  providers: Record<string, ProviderOverride> | undefined,
): ModelInfo[] {
  if (!providers) return [...catalog];

  const out = [...catalog];
  for (const [providerId, provider] of Object.entries(providers)) {
    const known = out.some((m) => m.family === providerId);
    for (const [modelId, override] of Object.entries(provider.models ?? {})) {
      const index = out.findIndex((m) => m.family === providerId && m.id === modelId);
      const existing = out[index];
      if (existing) {
        out[index] = mergeModel(existing, override, providerId);
      } else {
        out.push(bareModel(modelId, providerId, override));
      }
    }
    // A config provider the catalog has never heard of still exists, even
    // before its models resolve, so it shows up connected in the picker.
    if (!known && Object.keys(provider.models ?? {}).length === 0) {
      out.push(bareModel(providerId, providerId, {}));
    }
  }
  return out;
}

export interface ProviderFilterOptions {
  /** Provider families to exclude entirely. */
  disabledProviders?: readonly string[];
  /** When set, ONLY these provider families are kept. */
  enabledProviders?: readonly string[];
  /** Deprecated models are dropped unless this is set; alpha stays gated at the picker. */
  includeDeprecated?: boolean;
  /** Per-provider model id whitelist/blacklist from config. */
  providers?: Record<string, ProviderOverride>;
}

/**
 * The catalog filtering pass: disabled/enabled provider sets, per-provider
 * whitelist/blacklist, and deprecated models. Providers left with no models
 * disappear, matching opencode's behavior.
 */
export function filterModels(models: readonly ModelInfo[], options: ProviderFilterOptions = {}): ModelInfo[] {
  const disabled = new Set(options.disabledProviders ?? []);
  const enabled = options.enabledProviders ? new Set(options.enabledProviders) : undefined;

  const byFamily = new Map<string, ModelInfo[]>();
  for (const model of models) {
    if (disabled.has(model.family)) continue;
    if (enabled && !enabled.has(model.family)) continue;
    if (model.status === "deprecated" && !options.includeDeprecated) continue;

    const provider = options.providers?.[model.family];
    if (provider?.whitelist && !provider.whitelist.includes(model.id)) continue;
    if (provider?.blacklist?.includes(model.id)) continue;

    const family = byFamily.get(model.family) ?? [];
    family.push(model);
    byFamily.set(model.family, family);
  }

  return [...byFamily.values()].flat();
}

/**
 * Returns the available ModelInfo entries for a single provider family,
 * after applying the same filtering as `filterModels` (disabled/enabled
 * providers, per-provider whitelist/blacklist, deprecated exclusion).
 * Useful for deriving the model picker list for a specific agent's provider.
 */
export function availableModelsForProvider(
  providerId: string,
  catalog: readonly ModelInfo[],
  options: ProviderFilterOptions = {},
): ModelInfo[] {
  return filterModels(catalog, options).filter((m) => m.family === providerId);
}

export class ModelRegistry {
  private models: Map<string, ModelInfo>;

  constructor(seed: readonly ModelInfo[] = BUILTIN_MODELS) {
    this.models = new Map(seed.map((m) => [m.id, m]));
  }

  list(family?: string): ModelInfo[] {
    const all = [...this.models.values()];
    return family ? all.filter((m) => m.family === family) : all;
  }

  get(id: string): ModelInfo | undefined {
    return this.models.get(id);
  }

  /**
   * Merges live model IDs from a family's models-list endpoint into the
   * catalog. Known IDs keep their hand-tuned pricing/capabilities; unknown
   * ones are added bare, so a brand-new model shows up before anyone has
   * curated its numbers, rather than being invisible.
   */
  async refresh(family: string, http: HttpClient, apiKey: string): Promise<void> {
    const ids = await fetchLiveIds(family, http, apiKey);
    for (const id of ids) {
      if (!this.models.has(id)) {
        this.models.set(id, {
          id,
          family,
          contextWindow: 0,
          maxOutputTokens: 0,
          pricing: { inputPerMTok: 0, outputPerMTok: 0 },
          capabilities: { tools: false, vision: false, thinking: false },
        });
      }
    }
  }
}

/**
 * Live model IDs for one provider family, covering every known family plus a
 * generic OpenAI-compatible `/v1/models` fallback so custom gateways resolve
 * too. Unknown families without a baseUrl resolve to [] (catalog still serves).
 */
export async function fetchLiveIdsForFamily(
  family: string,
  http: HttpClient,
  apiKey: string,
  baseUrl?: string,
): Promise<string[]> {
  switch (family) {
    case "openai":
    case "deepseek":
    case "glm": {
      const base = baseUrl ?? (family === "openai" ? "https://api.openai.com/v1" : undefined);
      const url = base ? `${base.replace(/\/+$/, "")}/models` : "https://api.openai.com/v1/models";
      const res = await http.fetch(url, {
        headers: { authorization: `Bearer ${apiKey}` },
      });
      const body = (await res.json()) as { data: Array<{ id: string }> };
      return body.data.map((m) => m.id);
    }
    case "anthropic": {
      const res = await http.fetch("https://api.anthropic.com/v1/models", {
        headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
      });
      const body = (await res.json()) as { data: Array<{ id: string }> };
      return body.data.map((m) => m.id);
    }
    case "google": {
      const res = await http.fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`);
      const body = (await res.json()) as { models: Array<{ name: string }> };
      // Google returns "models/gemini-3-pro"; the bare id is what requests use.
      return body.models.map((m) => m.name.replace(/^models\//, ""));
    }
    default: {
      // Any other family (custom gateway): try the OpenAI-compatible shape
      // when a baseUrl is known, otherwise there is nothing to query.
      if (!baseUrl) return [];
      const res = await http.fetch(`${baseUrl.replace(/\/+$/, "")}/models`, {
        headers: { authorization: `Bearer ${apiKey}` },
      });
      const body = (await res.json()) as { data: Array<{ id: string }> };
      return body.data.map((m) => m.id);
    }
  }
}

async function fetchLiveIds(family: string, http: HttpClient, apiKey: string): Promise<string[]> {
  return fetchLiveIdsForFamily(family, http, apiKey);
}

// ---------------------------------------------------------------------------
// Provider metadata: per-provider routing facts above the model catalog.
// Downstream rotation and cheap-model routing read this, not ModelInfo.
// ---------------------------------------------------------------------------

/** Rate-limit hints for one provider; optional so unknowns stay partial. */
export interface ProviderRateLimit {
  readonly requestsPerMinute?: number;
  readonly tokensPerMinute?: number;
}

/** Static per-provider facts for routing; plain strings keep it extensible. */
export interface ProviderMetadata {
  readonly id: string;
  readonly family: string;
  readonly contextWindow: number;
  readonly costTier: string;
  readonly authKinds: readonly string[];
  readonly rateLimit?: ProviderRateLimit;
}

/** Thrown by getProviderMetadata for ids with no metadata record. */
export class UnknownProviderError extends Error {
  readonly providerId: string;
  constructor(providerId: string) {
    super(`Unknown provider: ${providerId}`);
    this.name = "UnknownProviderError";
    this.providerId = providerId;
  }
}

/** Hand-tuned per-provider facts; mirrors the families in BUILTIN_MODELS. */
export const BUILTIN_PROVIDER_METADATA: readonly ProviderMetadata[] = [
  {
    id: "anthropic",
    family: "anthropic",
    contextWindow: 200_000,
    costTier: "premium",
    authKinds: ["api-key", "oauth"],
    rateLimit: { requestsPerMinute: 60 },
  },
  {
    id: "openai",
    family: "openai",
    contextWindow: 400_000,
    costTier: "standard",
    authKinds: ["api-key", "oauth"],
    rateLimit: { requestsPerMinute: 500 },
  },
  {
    id: "google",
    family: "google",
    contextWindow: 1_000_000,
    costTier: "standard",
    authKinds: ["api-key", "oauth"],
    rateLimit: { requestsPerMinute: 300 },
  },
  {
    id: "deepseek",
    family: "deepseek",
    contextWindow: 128_000,
    costTier: "cheap",
    authKinds: ["api-key"],
    rateLimit: { requestsPerMinute: 200 },
  },
  {
    id: "glm",
    family: "glm",
    contextWindow: 128_000,
    costTier: "cheap",
    authKinds: ["api-key"],
    rateLimit: { requestsPerMinute: 200 },
  },
];

const providerMetadataById = new Map(BUILTIN_PROVIDER_METADATA.map((m) => [m.id, m]));

/** Lookup for one provider id; throws UnknownProviderError when absent. */
export function getProviderMetadata(id: string): ProviderMetadata {
  const meta = providerMetadataById.get(id);
  if (!meta) throw new UnknownProviderError(id);
  return meta;
}
