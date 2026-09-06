import { join } from "node:path";
import { type Config, dataDir, type ProviderConfig, parseModelRef } from "@agency/core";
import { BUILTIN_MODELS, loadCachedCatalog, type ModelInfo, mergeCatalogWithConfig } from "@agency/providers";

/** Offline model metadata: on-disk cache or build-time snapshot plus config overrides. */
export interface ModelCatalog {
  listModels: () => ModelInfo[];
  catalogModel: (provider: string, model: string) => ModelInfo | undefined;
  resolveAgentModel: (provider: string, model?: string) => string;
}

export function createModelCatalog(providers: Record<string, ProviderConfig>, config: Config): ModelCatalog {
  let mergedCatalog: ModelInfo[] | undefined;
  const ensureCatalog = (): ModelInfo[] => {
    if (!mergedCatalog) {
      mergedCatalog = mergeCatalogWithConfig(
        loadCachedCatalog(join(dataDir(), "cache"))?.models ?? BUILTIN_MODELS,
        providers,
      );
    }
    return mergedCatalog;
  };
  const catalogModel = (provider: string, model: string): ModelInfo | undefined => {
    return ensureCatalog().find((m) => m.id === model && m.family === provider);
  };
  const resolveAgentModel = (provider: string, model?: string): string => {
    if (model) return model;
    const ref = parseModelRef(config.model ?? "");
    if (ref && ref.provider === provider) return ref.model;
    const first = ensureCatalog().find((m) => m.family === provider);
    return first?.id ?? "";
  };
  return { listModels: () => ensureCatalog(), catalogModel, resolveAgentModel };
}
