import { join } from "node:path";
import type { Config } from "@agency/core";
import { dataDir, parseModelRef } from "@agency/core";
import type { HttpClient } from "@agency/net";
import {
  createKeychain,
  defaultModelIDs,
  filterModels,
  type KeychainBackend,
  loadModelsDevCatalog,
  type ModelCapabilities,
  type ModelInfo,
  type ModelPricing,
  type ModelStatus,
  mergeCatalogWithConfig,
  resolveApiKey,
} from "@agency/providers";

/** One model as the picker sees it: display data only, no adapter internals. */
export interface ProviderListModel {
  id: string;
  name: string;
  pricing: ModelPricing;
  contextWindow: number;
  capabilities: ModelCapabilities;
  status?: ModelStatus;
  releaseDate?: string;
  /** Provider API base URL from the catalog, for gateway-style providers. */
  apiBaseURL?: string;
}

export interface ProviderListEntry {
  id: string;
  name: string;
  models: ProviderListModel[];
}

/** Picker list result: everything the /models and /connect pickers need. */
export interface ProviderListResult {
  all: ProviderListEntry[];
  default: Record<string, string>;
  connected: string[];
}

function toListModel(model: ModelInfo): ProviderListModel {
  return {
    id: model.id,
    name: model.name ?? model.id,
    pricing: model.pricing,
    contextWindow: model.contextWindow,
    capabilities: model.capabilities,
    status: model.status,
    releaseDate: model.releaseDate,
    apiBaseURL: model.apiBaseURL,
  };
}

/**
 * Credential check per provider: declared config env vars first, then the
 * standard AGENCY_<ID>_API_KEY, then the keychain, then a config-file key.
 * A provider with any resolvable key counts as connected.
 */
async function connectedProviderIds(
  providerIds: readonly string[],
  config: Config,
  env: NodeJS.ProcessEnv,
  keychain: KeychainBackend,
): Promise<string[]> {
  const connected: string[] = [];
  for (const id of providerIds) {
    const providerConfig = config.provider[id];
    const key = await resolveApiKey({
      provider: id,
      env,
      keychain,
      declaredEnv: providerConfig?.env,
      config: providerConfig?.apiKey,
      oauthClientId: providerConfig?.oauth?.clientId,
      oauthBaseUrl: providerConfig?.oauth?.baseUrl,
    });
    if (key) connected.push(id);
  }
  return connected;
}

export async function listProviders(options: {
  config: Config;
  http: HttpClient;
  env?: NodeJS.ProcessEnv;
  cacheDir?: string;
  /** Pre-loaded catalog models; skips the models.dev fetch (tests, warm daemon). */
  catalog?: readonly ModelInfo[];
  keychain?: KeychainBackend;
  /** "connected": providers neither connected nor defined in config list no models (the full list is ~9k). */
  models?: "all" | "connected";
}): Promise<ProviderListResult> {
  const env = options.env ?? process.env;
  const catalog =
    options.catalog ??
    (
      await loadModelsDevCatalog({
        cacheDir: options.cacheDir ?? join(dataDir(env), "cache"),
        http: options.http,
        env,
      })
    ).models;

  const merged = mergeCatalogWithConfig(catalog, options.config.provider);
  const filtered = filterModels(merged, {
    disabledProviders: options.config.disabled_providers,
    enabledProviders: options.config.enabled_providers,
    providers: options.config.provider,
  });

  const byFamily = new Map<string, ModelInfo[]>();
  for (const model of filtered) {
    const family = byFamily.get(model.family) ?? [];
    family.push(model);
    byFamily.set(model.family, family);
  }

  const entries: ProviderListEntry[] = [...byFamily.entries()]
    .map(([id, models]) => ({
      id,
      name: models[0]?.providerName ?? options.config.provider[id]?.name ?? id,
      models: models.map(toListModel),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  const keychain = options.keychain ?? (await createKeychain(process.platform, join(dataDir(env), "keys")));

  const connected = await connectedProviderIds([...byFamily.keys()], options.config, env, keychain);
  const defaultProvider = parseModelRef(options.config.model ?? "")?.provider;
  const listed = new Set([...connected, ...Object.keys(options.config.provider)]);
  if (defaultProvider) listed.add(defaultProvider);
  return {
    all:
      options.models === "connected"
        ? entries.map((entry) => (listed.has(entry.id) ? entry : { ...entry, models: [] }))
        : entries,
    default: defaultModelIDs(filtered),
    connected,
  };
}
