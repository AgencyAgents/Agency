import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { HttpClient } from "@agency/net";
import { CATALOG_FRESH_TTL_MS, loadModelsDevCatalog } from "./catalog/models-dev.ts";
import {
  BUILTIN_MODELS,
  CATALOG_CACHE_VERSION,
  fetchLiveIdsForFamily,
  type ModelInfo,
  ModelRegistry,
  normalizeCachedCatalog,
} from "./registry.ts";

/**
 * Single canonical catalog TTL. The old per-family 24h window is gone: one
 * freshness discipline (the models.dev 5-minute TTL) governs every path.
 */
export const CATALOG_TTL_MS = CATALOG_FRESH_TTL_MS;

export interface CachedCatalog {
  /** Schema version; absent means v1 legacy, migrated forward on load. */
  version?: number;
  savedAt: string;
  models: ModelInfo[];
}

function catalogPath(cacheDir: string): string {
  return join(cacheDir, "model-catalog.json");
}

export function loadCachedCatalog(cacheDir: string): CachedCatalog | undefined {
  const path = catalogPath(cacheDir);
  if (!existsSync(path)) return undefined;
  try {
    return normalizeCachedCatalog(JSON.parse(readFileSync(path, "utf8"))) ?? undefined;
  } catch {
    return undefined;
  }
}

export function saveCachedCatalog(cacheDir: string, models: ModelInfo[]): void {
  mkdirSync(cacheDir, { recursive: true });
  writeFileSync(
    catalogPath(cacheDir),
    JSON.stringify({ version: CATALOG_CACHE_VERSION, savedAt: new Date().toISOString(), models }, null, 2),
  );
}

export function isStale(catalog: CachedCatalog, ttlMs: number): boolean {
  return Date.now() - new Date(catalog.savedAt).getTime() >= ttlMs;
}

export interface RefreshTarget {
  family: string;
  http: HttpClient;
  apiKey: string;
  baseUrl?: string;
}

export interface RefreshCatalogOptions {
  /** The builtin snapshot (BUILTIN_MODELS) — curated defaults. */
  builtin: readonly ModelInfo[];
  /** Models from models.dev catalog fetch — full catalog with pricing. */
  modelsDev: readonly ModelInfo[];
  /** Live IDs from provider endpoints, keyed by family (openai/anthropic/google). */
  liveIds: Record<string, string[]>;
}

/**
 * Reconciles three catalog sources into a single deduplicated list:
 *
 * 1. **Builtin snapshot** — hand-curated defaults with known pricing/capabilities.
 * 2. **models.dev fetch** — the full community catalog with per-model pricing.
 * 3. **Provider live list IDs** — the latest model IDs from each provider's API.
 *
 * Deduplication is by `${family}:${id}`. The merge order is:
 * - Builtin models are the base (known curated models).
 * - models.dev models overlay builtin (richer data wins).
 * - Live IDs add brand-new models not in either source (bare, no pricing).
 *
 * This ensures a model that exists in multiple sources keeps the richest
 * data (models.dev > builtin) while still catching brand-new models from
 * the live endpoint that neither snapshot knows about yet.
 */
export function refreshCatalog(options: RefreshCatalogOptions): ModelInfo[] {
  const map = new Map<string, ModelInfo>();
  const key = (m: ModelInfo): string => `${m.family}:${m.id}`;

  for (const model of options.builtin) {
    map.set(key(model), model);
  }

  for (const model of options.modelsDev) {
    map.set(key(model), model);
  }

  for (const [family, ids] of Object.entries(options.liveIds)) {
    for (const id of ids) {
      const k = `${family}:${id}`;
      if (!map.has(k)) {
        map.set(k, {
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

  return [...map.values()];
}

/**
 * Builds a registry seeded from the on-disk cache (or the built-in catalog if
 * there's no cache yet), refreshing it against live endpoints when the cache
 * is missing or past `ttlMs`. A refresh failure (offline, endpoint down) is
 * swallowed: the stale cache still serves, since a slightly outdated catalog
 * beats no catalog at all.
 */
export async function loadModelRegistry(options: {
  cacheDir: string;
  ttlMs?: number;
  refresh?: RefreshTarget[];
  modelsDev?: readonly ModelInfo[];
}): Promise<ModelRegistry> {
  const cached = loadCachedCatalog(options.cacheDir);
  const ttlMs = options.ttlMs ?? CATALOG_TTL_MS;
  const needsRefresh = !cached || isStale(cached, ttlMs);

  if (needsRefresh && options.refresh && options.refresh.length > 0) {
    const liveIds: Record<string, string[]> = {};
    let refreshed = false;
    for (const target of options.refresh) {
      try {
        liveIds[target.family] = await fetchLiveIdsForFamily(
          target.family,
          target.http,
          target.apiKey,
          target.baseUrl,
        );
        refreshed = true;
      } catch (error) {
        console.warn(
          `[catalog] refresh for "${target.family}" failed; serving stale cache: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    if (refreshed) {
      const merged = refreshCatalog({
        builtin: cached?.models ?? [],
        modelsDev: options.modelsDev ?? [],
        liveIds,
      });
      // Merge order and dedup above are untouched; an empty merge still
      // serves the builtin snapshot so the registry never goes empty.
      const models = merged.length > 0 ? merged : [...BUILTIN_MODELS];
      saveCachedCatalog(options.cacheDir, models);
      return new ModelRegistry(models);
    }
  }

  return new ModelRegistry(cached?.models?.length ? cached.models : undefined);
}

export async function loadCanonicalCatalog(options: {
  cacheDir: string;
  http: HttpClient;
  env?: NodeJS.ProcessEnv;
  ttlMs?: number;
  refresh?: RefreshTarget[];
  force?: boolean;
}): Promise<{ models: ModelInfo[]; source: "fresh" | "cache" | "builtin" }> {
  const ttlMs = options.ttlMs ?? CATALOG_TTL_MS;
  const dev = await loadModelsDevCatalog({
    cacheDir: options.cacheDir,
    http: options.http,
    env: options.env,
    ttlMs,
    force: options.force,
  });
  const liveIds: Record<string, string[]> = {};
  if (options.refresh) {
    for (const target of options.refresh) {
      try {
        liveIds[target.family] = await fetchLiveIdsForFamily(
          target.family,
          target.http,
          target.apiKey,
          target.baseUrl,
        );
      } catch (error) {
        console.warn(
          `[catalog] live ids for "${target.family}" failed; skipping: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }
  const models =
    dev.source === "builtin" && Object.keys(liveIds).length === 0
      ? [...BUILTIN_MODELS]
      : refreshCatalog({ builtin: BUILTIN_MODELS, modelsDev: dev.models, liveIds });
  if (models.length === 0) {
    console.warn("[catalog] merged catalog is empty; serving builtin snapshot");
    return { models: [...BUILTIN_MODELS], source: "builtin" as const };
  }
  saveCachedCatalog(options.cacheDir, models);
  return { models, source: dev.source };
}
