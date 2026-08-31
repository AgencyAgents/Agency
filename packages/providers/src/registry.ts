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

export interface ModelInfo {
  id: string;
  family: string;
  contextWindow: number;
  maxOutputTokens: number;
  pricing: ModelPricing;
  capabilities: ModelCapabilities;
}

/**
 * A small, hand-maintained snapshot — provider catalogs move fast enough that
 * this is a starting point, not a source of truth. `refresh()` reconciles it
 * against each family's live models endpoint.
 */
const BUILTIN: ModelInfo[] = [
  {
    id: "claude-opus-5",
    family: "anthropic",
    contextWindow: 200_000,
    maxOutputTokens: 32_000,
    pricing: { inputPerMTok: 15, outputPerMTok: 75, cachedInputPerMTok: 1.5 },
    capabilities: { tools: true, vision: true, thinking: true },
  },
  {
    id: "claude-sonnet-5",
    family: "anthropic",
    contextWindow: 200_000,
    maxOutputTokens: 64_000,
    pricing: { inputPerMTok: 3, outputPerMTok: 15, cachedInputPerMTok: 0.3 },
    capabilities: { tools: true, vision: true, thinking: true },
  },
  {
    id: "gpt-5.2",
    family: "openai",
    contextWindow: 400_000,
    maxOutputTokens: 128_000,
    pricing: { inputPerMTok: 5, outputPerMTok: 20, cachedInputPerMTok: 1.25 },
    capabilities: { tools: true, vision: true, thinking: true },
  },
  {
    id: "gemini-3-pro",
    family: "google",
    contextWindow: 1_000_000,
    maxOutputTokens: 65_536,
    pricing: { inputPerMTok: 2.5, outputPerMTok: 10 },
    capabilities: { tools: true, vision: true, thinking: true },
  },
];

export class ModelRegistry {
  private models: Map<string, ModelInfo>;

  constructor(seed: readonly ModelInfo[] = BUILTIN) {
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

async function fetchLiveIds(family: string, http: HttpClient, apiKey: string): Promise<string[]> {
  switch (family) {
    case "openai": {
      const res = await http.fetch("https://api.openai.com/v1/models", {
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
    default:
      return [];
  }
}
