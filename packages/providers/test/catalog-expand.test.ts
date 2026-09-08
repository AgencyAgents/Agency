import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HttpClient } from "@agency/net";
import { loadCanonicalCatalog, loadCachedCatalog, loadModelRegistry, refreshCatalog, saveCachedCatalog } from "../src/catalog-cache.ts";
import {
  convertModelsDevCatalogLenient,
  loadCachedModelsDevCatalog,
  MODELS_DEV_CACHE_FILE,
  saveModelsDevCatalog,
} from "../src/catalog/models-dev.ts";
import { BUILTIN_MODELS, CATALOG_CACHE_VERSION, type ModelInfo } from "../src/registry.ts";

const dirs: string[] = [];
let warnings: string[] = [];
const realWarn = console.warn;
beforeEach(() => {
  warnings = [];
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map(String).join(" "));
  };
});
afterEach(() => {
  console.warn = realWarn;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function setup(): string {
  const dir = mkdtempSync(join(tmpdir(), "agency-catalog-expand-"));
  dirs.push(dir);
  return dir;
}

function failingHttp(): HttpClient {
  return {
    fetch: async () => {
      throw new Error("upstream down");
    },
  };
}

function model(overrides: Partial<ModelInfo> & Pick<ModelInfo, "id" | "family">): ModelInfo {
  return {
    contextWindow: 100_000,
    maxOutputTokens: 8_000,
    pricing: { inputPerMTok: 1, outputPerMTok: 2 },
    capabilities: { tools: true, vision: false, thinking: false },
    ...overrides,
  };
}

function bigBlob(providers: number): Record<string, unknown> {
  const blob: Record<string, unknown> = {};
  for (let p = 0; p < providers; p++) {
    const models: Record<string, unknown> = {};
    for (let m = 0; m < 2; m++) {
      models[`model-${m}`] = {
        name: `Provider ${p} Model ${m}`,
        cost: { input: 0.000001 * (p + 1), output: 0.000002 * (p + 1) },
        limit: { context: 128_000, output: 8_000 },
        tool_call: true,
      };
    }
    blob[`provider-${p}`] = { name: `Provider ${p}`, models };
  }
  return blob;
}

describe("catalog expansion toward 75+ providers", () => {
  test("an 80-provider blob converts with pricing intact", () => {
    const models = convertModelsDevCatalogLenient(bigBlob(80));
    expect(models).toHaveLength(160);
    expect(new Set(models.map((m) => m.family)).size).toBe(80);
    const one = models.find((m) => m.family === "provider-0" && m.id === "model-0");
    expect(one?.pricing.inputPerMTok).toBeCloseTo(1, 10);
    expect(one?.pricing.outputPerMTok).toBeCloseTo(2, 10);
    const last = models.find((m) => m.family === "provider-79");
    expect(last?.pricing.inputPerMTok).toBeCloseTo(80, 10);
    expect(last?.capabilities.tools).toBe(true);
    expect(last?.apiNpm).toBe("@ai-sdk/openai-compatible");
  });

  test("new providers merge over builtin and resolve with pricing", () => {
    const dev = convertModelsDevCatalogLenient(bigBlob(80));
    const merged = refreshCatalog({ builtin: [...BUILTIN_MODELS], modelsDev: dev, liveIds: {} });
    expect(merged.length).toBe(BUILTIN_MODELS.length + 160);
    const probe = merged.find((m) => m.family === "provider-42" && m.id === "model-1");
    expect(probe?.pricing.inputPerMTok).toBeCloseTo(43, 10);
    expect(merged.some((m) => m.id === "claude-opus-5")).toBe(true);
  });

  test("malformed entries are skipped with a warning, valid ones survive", () => {
    const models = convertModelsDevCatalogLenient({
      good: {
        name: "Good",
        models: {
          ok: { name: "Ok", cost: { input: 0.000001, output: 0 }, limit: { context: 8_000 } },
          "no-limit": { name: "No Limit", cost: { input: 0, output: 0 } },
          "no-name": { cost: { input: 0, output: 0 }, limit: { context: 1 } },
        },
      },
      broken: null,
      "no-models": { name: "Empty" },
    });
    expect(models.map((m) => m.id).sort()).toEqual(["no-limit", "ok"]);
    expect(models.find((m) => m.id === "no-limit")?.contextWindow).toBe(0);
    expect(warnings.some((w) => w.includes("malformed"))).toBe(true);
    expect(convertModelsDevCatalogLenient(null)).toEqual([]);
  });

  test("merge order holds: builtin base, models.dev overlay, live bare ids", () => {
    const builtin = [model({ id: "m", family: "f", name: "base", pricing: { inputPerMTok: 1, outputPerMTok: 1 } })];
    const modelsDev = [model({ id: "m", family: "f", name: "overlay", pricing: { inputPerMTok: 9, outputPerMTok: 9 } })];
    const merged = refreshCatalog({ builtin, modelsDev, liveIds: { f: ["m", "fresh-id"], g: ["m"] } });
    expect(merged.filter((m) => `${m.family}:${m.id}` === "f:m")).toHaveLength(1);
    expect(merged.find((m) => m.family === "f" && m.id === "m")?.pricing.inputPerMTok).toBe(9);
    expect(merged.find((m) => m.id === "fresh-id")?.pricing.inputPerMTok).toBe(0);
    expect(merged.filter((m) => m.id === "m")).toHaveLength(2);
  });
});

describe("versioned caches with unversioned migration", () => {
  test("both cache files stamp the current version on save", () => {
    const dir = setup();
    const seed = [model({ id: "a", family: "f" })];
    saveCachedCatalog(dir, seed);
    saveModelsDevCatalog(dir, seed);
    expect(loadCachedCatalog(dir)?.version).toBe(CATALOG_CACHE_VERSION);
    expect(loadCachedModelsDevCatalog(dir)?.version).toBe(CATALOG_CACHE_VERSION);
  });

  test("unversioned legacy files migrate forward without data loss", () => {
    const dir = setup();
    const legacy = { savedAt: new Date().toISOString(), models: [model({ id: "legacy", family: "f" })] };
    writeFileSync(join(dir, "model-catalog.json"), JSON.stringify(legacy));
    writeFileSync(join(dir, MODELS_DEV_CACHE_FILE), JSON.stringify(legacy));
    expect(loadCachedCatalog(dir)?.models[0]?.id).toBe("legacy");
    expect(loadCachedCatalog(dir)?.version).toBe(1);
    expect(loadCachedModelsDevCatalog(dir)?.models[0]?.id).toBe("legacy");
    saveCachedCatalog(dir, loadCachedCatalog(dir)?.models ?? []);
    expect(loadCachedCatalog(dir)?.version).toBe(CATALOG_CACHE_VERSION);
  });

  test("corrupt caches read as absent, future versions still serve", () => {
    const dir = setup();
    writeFileSync(join(dir, "model-catalog.json"), "{not json");
    writeFileSync(join(dir, MODELS_DEV_CACHE_FILE), JSON.stringify({ models: "nope" }));
    expect(loadCachedCatalog(dir)).toBeUndefined();
    expect(loadCachedModelsDevCatalog(dir)).toBeUndefined();
    const skewed = { version: 99, savedAt: new Date().toISOString(), models: [model({ id: "s", family: "f" })] };
    writeFileSync(join(dir, "model-catalog.json"), JSON.stringify(skewed));
    expect(loadCachedCatalog(dir)?.models[0]?.id).toBe("s");
  });
});

describe("offline and live-down fallback", () => {
  test("upstream plus live ids down serves the stale cache with a warning", async () => {
    const dir = setup();
    const stale = [model({ id: "stale-1", family: "openai" })];
    saveCachedCatalog(dir, stale);
    saveModelsDevCatalog(dir, stale);
    writeFileSync(
      join(dir, "model-catalog.json"),
      JSON.stringify({ version: 1, savedAt: new Date(0).toISOString(), models: stale }),
    );
    const backdated = { version: 1, savedAt: new Date(0).toISOString(), models: stale };
    writeFileSync(join(dir, MODELS_DEV_CACHE_FILE), JSON.stringify(backdated));

    const http = failingHttp();
    const result = await loadCanonicalCatalog({
      cacheDir: dir,
      http,
      ttlMs: 1,
      refresh: [{ family: "openai", http, apiKey: "k" }],
    });
    expect(result.models.some((m) => m.id === "stale-1")).toBe(true);
    expect(warnings.some((w) => w.includes("stale cache"))).toBe(true);
  });

  test("cold boot with nothing cached falls back to builtin, never empty", async () => {
    const dir = setup();
    const result = await loadCanonicalCatalog({ cacheDir: dir, http: failingHttp() });
    expect(result.source).toBe("builtin");
    expect(result.models.length).toBeGreaterThan(0);
    const registry = await loadModelRegistry({ cacheDir: setup() });
    expect(registry.list().length).toBeGreaterThan(0);
  });

  test("a poisoned empty cache still serves builtin instead of an empty registry", async () => {
    const dir = setup();
    writeFileSync(
      join(dir, MODELS_DEV_CACHE_FILE),
      JSON.stringify({ version: 1, savedAt: new Date(0).toISOString(), models: [] }),
    );
    const result = await loadCanonicalCatalog({ cacheDir: dir, http: failingHttp(), ttlMs: 1 });
    expect(result.models.length).toBeGreaterThan(0);
    expect(result.models.some((m) => m.id === "claude-opus-5")).toBe(true);
  });
});
