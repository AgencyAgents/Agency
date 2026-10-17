import { join } from "node:path";
import { type Config, dataDir, type ProviderConfig, parseModelRef } from "@agency/core";
import type { HttpClient } from "@agency/net";
import {
  BUILTIN_MODELS,
  fetchOpenRouterModels,
  GATEWAY_BASE_URLS,
  loadCachedCatalog,
  loadCachedModelsDevCatalog,
  type ModelInfo,
  mergeCatalogWithConfig,
} from "@agency/providers";

/** Model metadata: on-disk cache or build-time snapshot, plus what a gateway's own list says, plus config overrides. */
export interface ModelCatalog {
  listModels: () => ModelInfo[];
  catalogModel: (provider: string, model: string) => ModelInfo | undefined;
  resolveAgentModel: (provider: string, model?: string) => string;
  /** Reads the model list of OpenRouter when the catalog does not know one of its models. */
  learnModel: (provider: string, model: string, http: HttpClient) => Promise<void>;
}

/** A turn waits at most this long for the model list. */
const LEARN_TIMEOUT_MS = 4000;

export function createModelCatalog(providers: Record<string, ProviderConfig>, config: Config): ModelCatalog {
  let base: readonly ModelInfo[] | undefined;
  let mergedCatalog: ModelInfo[] | undefined;
  const ensureCatalog = (): ModelInfo[] => {
    if (!mergedCatalog) {
      base ??= loadCachedCatalog(join(dataDir(), "cache"))?.models ?? BUILTIN_MODELS;
      mergedCatalog = mergeCatalogWithConfig(base, providers);
    }
    return mergedCatalog;
  };
  // The levels come from models.dev, which the picker shows. Its limits do not: the base entry's stay.
  const catalogModel = (provider: string, model: string): ModelInfo | undefined => {
    const found = ensureCatalog().find((m) => m.id === model && m.family === provider);
    if (!found || found.efforts) return found;
    const efforts = loadCachedModelsDevCatalog(join(dataDir(), "cache"))?.models.find(
      (m) => m.id === model && m.family === provider,
    )?.efforts;
    return efforts ? { ...found, efforts } : found;
  };
  const resolveAgentModel = (provider: string, model?: string): string => {
    if (model) return model;
    const ref = parseModelRef(config.model ?? "");
    if (ref && ref.provider === provider) return ref.model;
    const first = ensureCatalog().find((m) => m.family === provider);
    return first?.id ?? "";
  };
  // One read for the life of the daemon. After a failure the defaults stay: a turn must not wait a second time.
  let learned: Promise<void> | undefined;
  const learnModel = (provider: string, model: string, http: HttpClient): Promise<void> => {
    if (provider !== "openrouter" || catalogModel(provider, model)) return Promise.resolve();
    const baseUrl = providers.openrouter?.baseUrl ?? GATEWAY_BASE_URLS.openrouter ?? "";
    learned ??= fetchOpenRouterModels(http, baseUrl, AbortSignal.timeout(LEARN_TIMEOUT_MS))
      .then((models) => {
        base = [...(base ?? BUILTIN_MODELS), ...models];
        mergedCatalog = undefined;
      })
      .catch(() => {});
    return learned;
  };
  return { listModels: () => ensureCatalog(), catalogModel, resolveAgentModel, learnModel };
}
