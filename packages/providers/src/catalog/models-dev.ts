import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { HttpClient } from "@agency/net";
import { z } from "zod";
import type { CachedCatalog } from "../catalog-cache.ts";
import { isStale } from "../catalog-cache.ts";
import { BUILTIN_MODELS, type ModelInfo, type ModelStatus } from "../registry.ts";

/**
 * The models.dev catalog (mirrored at models.opencode.ai) as a single blob:
 * every provider, every model, with pricing, limits, modalities, and status.
 * One fetch replaces per-provider model-list calls, which is what lets Agency
 * accept arbitrary providers without hand-curating each one.
 */

export const MODELS_DEV_URL = "https://models.opencode.ai/api.json";

/** How long a disk-cached catalog is trusted without a network round-trip. */
export const CATALOG_FRESH_TTL_MS = 5 * 60 * 1000;

const FETCH_TIMEOUT_MS = 10_000;
/** Initial attempt plus two transient retries, exponential with jitter. */
const FETCH_ATTEMPTS = 3;

/** Env override for the catalog source URL (opencode parity). */
export function modelsDevUrl(env: NodeJS.ProcessEnv = process.env): string {
  return env.OPENCODE_MODELS_URL ?? MODELS_DEV_URL;
}

// ---------------------------------------------------------------------------
// Wire schemas (models.dev api.json). Costs here are USD per token; Agency's
// ModelPricing is per MTok, so conversion multiplies by 1e6 at ingest.
// ---------------------------------------------------------------------------

const ModelsDevCostSchema = z.object({
  input: z.coerce.number().optional(),
  output: z.coerce.number().optional(),
  cache_read: z.coerce.number().optional(),
  cache_write: z.coerce.number().optional(),
});

const ModelsDevLimitSchema = z.object({
  context: z.coerce.number(),
  input: z.coerce.number().optional(),
  output: z.coerce.number().optional(),
});

const ModelsDevModalitiesSchema = z.object({
  input: z.array(z.string()).optional(),
  output: z.array(z.string()).optional(),
});

const ModelsDevStatusSchema = z.enum(["alpha", "beta", "deprecated", "active"]);

const ModelsDevModelSchema = z.object({
  id: z.string().optional(),
  name: z.string(),
  family: z.string().optional(),
  release_date: z.string().optional(),
  attachment: z.boolean().optional(),
  reasoning: z.boolean().optional(),
  temperature: z.boolean().optional(),
  tool_call: z.boolean().optional(),
  cost: ModelsDevCostSchema.optional(),
  limit: ModelsDevLimitSchema,
  modalities: ModelsDevModalitiesSchema.optional(),
  status: ModelsDevStatusSchema.optional(),
  provider: z
    .object({
      npm: z.string().optional(),
      api: z.string().optional(),
    })
    .optional(),
});

const ModelsDevProviderSchema = z.object({
  api: z.string().optional(),
  name: z.string(),
  env: z.array(z.string()).optional(),
  id: z.string().optional(),
  npm: z.string().optional(),
  models: z.record(z.string(), ModelsDevModelSchema),
});

export const ModelsDevCatalogSchema = z.record(z.string(), ModelsDevProviderSchema);

export type ModelsDevModel = z.infer<typeof ModelsDevModelSchema>;
export type ModelsDevProvider = z.infer<typeof ModelsDevProviderSchema>;
export type ModelsDevCatalog = Record<string, ModelsDevProvider>;

/** models.dev costs are per token; Agency prices per million tokens. */
const PER_MTOK = 1_000_000;

/** The generic client package that makes any OpenAI-compatible endpoint work. */
const DEFAULT_NPM = "@ai-sdk/openai-compatible";

/**
 * Converts the raw catalog blob into Agency's flat ModelInfo list. The
 * provider id becomes the family, so catalog families line up with the
 * builtin adapter families and unknown providers fall through to the
 * openai-compatible adapter at request time.
 */
export function convertModelsDevCatalog(raw: ModelsDevCatalog): ModelInfo[] {
  const out: ModelInfo[] = [];
  for (const [providerId, provider] of Object.entries(raw)) {
    for (const [modelKey, model] of Object.entries(provider.models)) {
      const id = model.id ?? modelKey;
      const inputModalities = model.modalities?.input;
      out.push({
        id,
        family: providerId,
        name: model.name,
        providerName: provider.name,
        contextWindow: model.limit.context,
        maxOutputTokens: model.limit.output ?? 0,
        pricing: {
          inputPerMTok: (model.cost?.input ?? 0) * PER_MTOK,
          outputPerMTok: (model.cost?.output ?? 0) * PER_MTOK,
          cachedInputPerMTok:
            model.cost?.cache_read !== undefined ? model.cost.cache_read * PER_MTOK : undefined,
        },
        capabilities: {
          tools: model.tool_call ?? false,
          vision: inputModalities?.includes("image") ?? false,
          thinking: model.reasoning ?? false,
        },
        status: model.status,
        releaseDate: model.release_date,
        inputModalities,
        apiBaseURL: model.provider?.api ?? provider.api,
        apiNpm: model.provider?.npm ?? provider.npm ?? DEFAULT_NPM,
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Disk cache: same CachedCatalog shape as the per-family cache, own file so
// the two mechanisms never overwrite each other. Writes are atomic (tmp +
// rename) so a crash mid-write can only leave the old file intact.
// ---------------------------------------------------------------------------

export const MODELS_DEV_CACHE_FILE = "models-dev-catalog.json";

function catalogPath(cacheDir: string): string {
  return join(cacheDir, MODELS_DEV_CACHE_FILE);
}

export function loadCachedModelsDevCatalog(cacheDir: string): CachedCatalog | undefined {
  const path = catalogPath(cacheDir);
  if (!existsSync(path)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as CachedCatalog;
    return Array.isArray(parsed.models) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

export function saveModelsDevCatalog(cacheDir: string, models: readonly ModelInfo[]): void {
  mkdirSync(cacheDir, { recursive: true });
  const path = catalogPath(cacheDir);
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  const catalog: CachedCatalog = { savedAt: new Date().toISOString(), models: [...models] };
  writeFileSync(tmp, JSON.stringify(catalog, null, 2));
  renameSync(tmp, path);
}

// ---------------------------------------------------------------------------
// Fetch + orchestration
// ---------------------------------------------------------------------------

export async function fetchModelsDevCatalog(http: HttpClient, url: string): Promise<ModelsDevCatalog> {
  let lastError: unknown;
  for (let attempt = 0; attempt < FETCH_ATTEMPTS; attempt++) {
    if (attempt > 0) {
      const base = 200 * 2 ** (attempt - 1);
      await new Promise((resolve) => setTimeout(resolve, base + Math.random() * base));
    }
    try {
      const res = await http.fetch(url, {
        headers: { "user-agent": "agency/0.1.0" },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`catalog fetch failed with ${res.status} ${res.statusText}`);
      const body: unknown = await res.json();
      return ModelsDevCatalogSchema.parse(body);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

export interface ModelsDevCatalogResult {
  models: ModelInfo[];
  /** fresh: just fetched; cache: disk (possibly stale); builtin: offline snapshot. */
  source: "fresh" | "cache" | "builtin";
}

/**
 * Loads the catalog with opencode's freshness discipline: a disk cache younger
 * than the TTL is served without touching the network; otherwise one fetch
 * attempt runs and, on any failure, the stale cache still serves (stale-ok).
 * With neither cache nor network, the build-time BUILTIN snapshot answers so
 * the picker and adapter resolution never go dark.
 */
export async function loadModelsDevCatalog(options: {
  cacheDir: string;
  http: HttpClient;
  env?: NodeJS.ProcessEnv;
  url?: string;
  ttlMs?: number;
  /** Skip the fresh-cache shortcut and fetch even when the cache is young. */
  force?: boolean;
}): Promise<ModelsDevCatalogResult> {
  const env = options.env ?? process.env;
  const cached = loadCachedModelsDevCatalog(options.cacheDir);
  const ttlMs = options.ttlMs ?? CATALOG_FRESH_TTL_MS;

  const offline = env.OPENCODE_DISABLE_MODELS_FETCH !== undefined;
  const fresh = !options.force && cached !== undefined && !isStale(cached, ttlMs);
  if (offline || fresh) {
    return { models: cached?.models ?? BUILTIN_MODELS, source: cached ? "cache" : "builtin" };
  }

  try {
    const raw = await fetchModelsDevCatalog(options.http, options.url ?? modelsDevUrl(env));
    const models = convertModelsDevCatalog(raw);
    saveModelsDevCatalog(options.cacheDir, models);
    return { models, source: "fresh" };
  } catch {
    // Offline or the mirror is down: a slightly outdated catalog beats none.
    return { models: cached?.models ?? BUILTIN_MODELS, source: cached ? "cache" : "builtin" };
  }
}

export type { ModelStatus };
