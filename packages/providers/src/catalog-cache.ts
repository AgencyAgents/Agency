import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { HttpClient } from "@agency/net";
import { type ModelInfo, ModelRegistry } from "./registry.ts";

export interface CachedCatalog {
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
    return JSON.parse(readFileSync(path, "utf8")) as CachedCatalog;
  } catch {
    return undefined;
  }
}

export function saveCachedCatalog(cacheDir: string, models: ModelInfo[]): void {
  mkdirSync(cacheDir, { recursive: true });
  writeFileSync(
    catalogPath(cacheDir),
    JSON.stringify({ savedAt: new Date().toISOString(), models }, null, 2),
  );
}

export function isStale(catalog: CachedCatalog, ttlMs: number): boolean {
  return Date.now() - new Date(catalog.savedAt).getTime() > ttlMs;
}

export interface RefreshTarget {
  family: string;
  http: HttpClient;
  apiKey: string;
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
}): Promise<ModelRegistry> {
  const cached = loadCachedCatalog(options.cacheDir);
  const registry = new ModelRegistry(cached?.models);
  const ttlMs = options.ttlMs ?? 24 * 60 * 60 * 1000;
  const needsRefresh = !cached || isStale(cached, ttlMs);

  if (needsRefresh && options.refresh && options.refresh.length > 0) {
    let refreshed = false;
    for (const target of options.refresh) {
      try {
        await registry.refresh(target.family, target.http, target.apiKey);
        refreshed = true;
      } catch {
        // Offline or the endpoint is unreachable: keep serving what's cached.
      }
    }
    if (refreshed) saveCachedCatalog(options.cacheDir, registry.list());
  }

  return registry;
}
