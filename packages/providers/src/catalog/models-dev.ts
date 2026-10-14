import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { HttpClient } from "@agency/net";
import { z } from "zod";
import type { CachedCatalog } from "../catalog-cache.ts";
import {
  BUILTIN_MODELS,
  CATALOG_CACHE_VERSION,
  type ModelInfo,
  type ModelStatus,
  normalizeCachedCatalog,
} from "../registry.ts";

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

/** Env override for the catalog source URL; the opencode name stays as a
 *  one-release fallback for existing setups. */
export function modelsDevUrl(env: NodeJS.ProcessEnv = process.env): string {
  return env.AGENCY_MODELS_URL ?? env.OPENCODE_MODELS_URL ?? MODELS_DEV_URL;
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
 * Maps one validated wire model onto Agency's flat ModelInfo. Shared by the
 * strict converter and the lenient one below, so both agree on pricing math.
 */
function mapModel(
  providerId: string,
  providerName: string,
  providerApi: string | undefined,
  providerNpm: string | undefined,
  modelKey: string,
  model: ModelsDevModel,
): ModelInfo {
  const id = model.id ?? modelKey;
  const inputModalities = model.modalities?.input;
  return {
    id,
    family: providerId,
    name: model.name,
    providerName,
    contextWindow: model.limit.context,
    maxOutputTokens: model.limit.output ?? 0,
    pricing: {
      inputPerMTok: (model.cost?.input ?? 0) * PER_MTOK,
      outputPerMTok: (model.cost?.output ?? 0) * PER_MTOK,
      cachedInputPerMTok: model.cost?.cache_read !== undefined ? model.cost.cache_read * PER_MTOK : undefined,
    },
    capabilities: {
      tools: model.tool_call ?? false,
      vision: inputModalities?.includes("image") ?? false,
      thinking: model.reasoning ?? false,
    },
    status: model.status,
    releaseDate: model.release_date,
    inputModalities,
    apiBaseURL: model.provider?.api ?? providerApi,
    apiNpm: model.provider?.npm ?? providerNpm ?? DEFAULT_NPM,
  };
}

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
      out.push(mapModel(providerId, provider.name, provider.api, provider.npm, modelKey, model));
    }
  }
  return out;
}

/**
 * Second converter for the same blob, entry-tolerant: a malformed entry is
 * skipped, never sinking the 75+ provider catalog. Feeds the modelsDev merge
 * slot, so merge order and `${family}:${id}` dedup hold.
 */
export function convertModelsDevCatalogLenient(raw: unknown): ModelInfo[] {
  if (typeof raw !== "object" || raw === null) return [];
  const out: ModelInfo[] = [];
  for (const [providerId, rawProvider] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof rawProvider !== "object" || rawProvider === null) {
      console.warn(`[catalog] skipping malformed provider "${providerId}"`);
      continue;
    }
    const p = rawProvider as Record<string, unknown>;
    const name = typeof p.name === "string" ? p.name : providerId;
    const api = typeof p.api === "string" ? p.api : undefined;
    const npm = typeof p.npm === "string" ? p.npm : undefined;
    const models = p.models;
    if (typeof models !== "object" || models === null) {
      console.warn(`[catalog] skipping provider "${providerId}" with no models map`);
      continue;
    }
    for (const [modelKey, rawModel] of Object.entries(models as Record<string, unknown>)) {
      const candidate =
        typeof rawModel === "object" && rawModel !== null && !("limit" in rawModel)
          ? { ...rawModel, limit: { context: 0 } }
          : rawModel;
      const parsed = ModelsDevModelSchema.safeParse(candidate);
      if (!parsed.success) {
        console.warn(`[catalog] skipping malformed model "${providerId}:${modelKey}"`);
        continue;
      }
      out.push(mapModel(providerId, name, api, npm, modelKey, parsed.data));
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
    return normalizeCachedCatalog(JSON.parse(readFileSync(path, "utf8"))) ?? undefined;
  } catch {
    return undefined;
  }
}

export function saveModelsDevCatalog(cacheDir: string, models: readonly ModelInfo[]): void {
  mkdirSync(cacheDir, { recursive: true });
  const path = catalogPath(cacheDir);
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  const catalog: CachedCatalog = {
    version: CATALOG_CACHE_VERSION,
    savedAt: new Date().toISOString(),
    models: [...models],
  };
  writeFileSync(tmp, JSON.stringify(catalog, null, 2));
  renameSync(tmp, path);
}

// ---------------------------------------------------------------------------
// Fetch + orchestration
// ---------------------------------------------------------------------------

async function fetchCatalogJson(http: HttpClient, url: string): Promise<unknown> {
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
      return (await res.json()) as unknown;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

export async function fetchModelsDevCatalog(http: HttpClient, url: string): Promise<ModelsDevCatalog> {
  return ModelsDevCatalogSchema.parse(await fetchCatalogJson(http, url));
}

export interface ModelsDevCatalogResult {
  models: ModelInfo[];
  /** fresh: just fetched; cache: disk (possibly stale); builtin: offline snapshot. */
  source: "fresh" | "cache" | "builtin";
}

/**
 * Loads the catalog with a stale-ok freshness discipline: a disk cache younger
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

  const offline =
    env.AGENCY_DISABLE_MODELS_FETCH !== undefined || env.OPENCODE_DISABLE_MODELS_FETCH !== undefined;
  // Resolved lazily (not a top-level import): catalog-cache.ts reads this
  // module's CATALOG_FRESH_TTL_MS at its own top level, so a static back-edge
  // would deadlock evaluation order (TDZ) depending on entry point.
  const { isStale } = await import("../catalog-cache.ts");
  const fresh = !options.force && cached !== undefined && !isStale(cached, ttlMs);
  const cachedModels = cached !== undefined && cached.models.length > 0 ? cached.models : undefined;
  if (offline || fresh) {
    return { models: cachedModels ?? BUILTIN_MODELS, source: cachedModels ? "cache" : "builtin" };
  }

  try {
    const raw = await fetchCatalogJson(options.http, options.url ?? modelsDevUrl(env));
    const models = convertModelsDevCatalogLenient(raw);
    if (models.length === 0) throw new Error("catalog parsed to zero models");
    saveModelsDevCatalog(options.cacheDir, models);
    return { models, source: "fresh" };
  } catch (error) {
    console.warn(
      `[catalog] models.dev fetch failed; serving ${cachedModels ? "stale cache" : "builtin snapshot"}: ${error instanceof Error ? error.message : String(error)}`,
    );
    return { models: cachedModels ?? BUILTIN_MODELS, source: cachedModels ? "cache" : "builtin" };
  }
}

export type { ModelStatus };
