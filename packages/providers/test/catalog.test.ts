import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HttpClient } from "@agency/net";
import {
  CATALOG_FRESH_TTL_MS,
  convertModelsDevCatalog,
  fetchModelsDevCatalog,
  loadCachedModelsDevCatalog,
  loadModelsDevCatalog,
  MODELS_DEV_CACHE_FILE,
  ModelsDevCatalogSchema,
  saveModelsDevCatalog,
} from "../src/catalog/models-dev.ts";
import {
  defaultModelIDs,
  filterModels,
  type ModelInfo,
  mergeCatalogWithConfig,
  sortModels,
} from "../src/registry.ts";

const SAMPLE_CATALOG = {
  anthropic: {
    api: "https://api.anthropic.com",
    name: "Anthropic",
    env: ["ANTHROPIC_API_KEY"],
    models: {
      "claude-opus-5": {
        name: "Claude Opus 5",
        release_date: "2026-05-01",
        tool_call: true,
        reasoning: true,
        cost: { input: 0.000015, output: 0.000075, cache_read: 0.0000015 },
        limit: { context: 200000, output: 32000 },
        modalities: { input: ["text", "image"] },
      },
      "claude-old": {
        name: "Claude Old",
        status: "deprecated",
        cost: { input: 0, output: 0 },
        limit: { context: 100000 },
      },
    },
  },
  "my-gateway": {
    name: "My Gateway",
    models: {
      "llama-4": {
        name: "Llama 4",
        cost: { input: 0, output: 0 },
        limit: { context: 128000 },
      },
    },
  },
};

function model(overrides: Partial<ModelInfo> & Pick<ModelInfo, "id" | "family">): ModelInfo {
  return {
    contextWindow: 100_000,
    maxOutputTokens: 8_000,
    pricing: { inputPerMTok: 1, outputPerMTok: 2 },
    capabilities: { tools: true, vision: false, thinking: false },
    ...overrides,
  };
}

describe("convertModelsDevCatalog", () => {
  test("converts per-token costs to per-MTok by x1e6", () => {
    const models = convertModelsDevCatalog(ModelsDevCatalogSchema.parse(SAMPLE_CATALOG));
    const opus = models.find((m) => m.id === "claude-opus-5");
    expect(opus?.pricing.inputPerMTok).toBe(15);
    expect(opus?.pricing.outputPerMTok).toBe(75);
    expect(opus?.pricing.cachedInputPerMTok).toBe(1.5);
  });

  test("maps modalities and reasoning flags onto capabilities", () => {
    const models = convertModelsDevCatalog(ModelsDevCatalogSchema.parse(SAMPLE_CATALOG));
    const opus = models.find((m) => m.id === "claude-opus-5");
    expect(opus?.capabilities).toEqual({ tools: true, vision: true, thinking: true });
    expect(opus?.inputModalities).toEqual(["text", "image"]);
  });

  test("provider id becomes the family and provider api becomes apiBaseURL", () => {
    const models = convertModelsDevCatalog(ModelsDevCatalogSchema.parse(SAMPLE_CATALOG));
    const opus = models.find((m) => m.id === "claude-opus-5");
    expect(opus?.family).toBe("anthropic");
    expect(opus?.apiBaseURL).toBe("https://api.anthropic.com");
    expect(opus?.providerName).toBe("Anthropic");
  });

  test("unknown providers fall back to the openai-compatible npm package", () => {
    const models = convertModelsDevCatalog(ModelsDevCatalogSchema.parse(SAMPLE_CATALOG));
    const llama = models.find((m) => m.id === "llama-4");
    expect(llama?.apiNpm).toBe("@ai-sdk/openai-compatible");
    expect(llama?.family).toBe("my-gateway");
  });
});

describe("models-dev disk cache", () => {
  test("save then load round-trips the converted models atomically", () => {
    const dir = mkdtempSync(join(tmpdir(), "agency-catalog-test-"));
    try {
      const models = convertModelsDevCatalog(ModelsDevCatalogSchema.parse(SAMPLE_CATALOG));
      saveModelsDevCatalog(dir, models);

      const loaded = loadCachedModelsDevCatalog(dir);
      expect(loaded?.models).toHaveLength(models.length);
      expect(loaded?.models.find((m) => m.id === "claude-opus-5")?.pricing.inputPerMTok).toBe(15);
      expect(readFileSync(join(dir, MODELS_DEV_CACHE_FILE), "utf8")).toContain("savedAt");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a corrupt cache file is treated as absent, not fatal", () => {
    const dir = mkdtempSync(join(tmpdir(), "agency-catalog-test-"));
    try {
      writeFileSync(join(dir, MODELS_DEV_CACHE_FILE), "{not json");
      expect(loadCachedModelsDevCatalog(dir)).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("loadModelsDevCatalog", () => {
  function httpWith(body: unknown, status = 200): HttpClient {
    return { fetch: async () => new Response(JSON.stringify(body), { status }) };
  }

  test("serves a fresh cache without touching the network", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agency-catalog-test-"));
    try {
      const models = convertModelsDevCatalog(ModelsDevCatalogSchema.parse(SAMPLE_CATALOG));
      saveModelsDevCatalog(dir, models);

      const result = await loadModelsDevCatalog({
        cacheDir: dir,
        http: {
          fetch: async () => {
            throw new Error("network must not be touched");
          },
        },
      });
      expect(result.source).toBe("cache");
      expect(result.models).toHaveLength(models.length);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("force bypasses the fresh-cache shortcut and refetches", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agency-catalog-test-"));
    try {
      saveModelsDevCatalog(dir, [model({ id: "stale", family: "x" })]);

      const result = await loadModelsDevCatalog({
        cacheDir: dir,
        http: httpWith(SAMPLE_CATALOG),
        force: true,
      });
      expect(result.source).toBe("fresh");
      expect(result.models.find((m) => m.id === "claude-opus-5")).toBeDefined();
      expect(result.models.find((m) => m.id === "stale")).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a failed fetch falls back to the stale cache (stale-ok)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agency-catalog-test-"));
    try {
      saveModelsDevCatalog(dir, [model({ id: "stale-but-usable", family: "x" })]);
      // Backdate past the TTL so the cache is stale.
      const path = join(dir, MODELS_DEV_CACHE_FILE);
      const cached = JSON.parse(readFileSync(path, "utf8")) as { savedAt: string };
      cached.savedAt = new Date(Date.now() - CATALOG_FRESH_TTL_MS - 1000).toISOString();
      writeFileSync(path, JSON.stringify(cached));

      const result = await loadModelsDevCatalog({
        cacheDir: dir,
        http: { fetch: async () => new Response("nope", { status: 500 }) },
      });
      expect(result.source).toBe("cache");
      expect(result.models[0]?.id).toBe("stale-but-usable");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("with no cache and no network, the builtin snapshot answers", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agency-catalog-test-"));
    try {
      const result = await loadModelsDevCatalog({
        cacheDir: dir,
        http: {
          fetch: async () => {
            throw new Error("offline");
          },
        },
      });
      expect(result.source).toBe("builtin");
      expect(result.models.length).toBeGreaterThan(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("OPENCODE_DISABLE_MODELS_FETCH skips the network entirely", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agency-catalog-test-"));
    try {
      const result = await loadModelsDevCatalog({
        cacheDir: dir,
        http: {
          fetch: async () => {
            throw new Error("must not be called");
          },
        },
        env: { OPENCODE_DISABLE_MODELS_FETCH: "1" },
      });
      expect(result.source).toBe("builtin");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("fetchModelsDevCatalog", () => {
  test("retries transient failures before giving up", async () => {
    let calls = 0;
    const http: HttpClient = {
      fetch: async () => {
        calls += 1;
        if (calls < 3) return new Response("boom", { status: 503 });
        return new Response(JSON.stringify(SAMPLE_CATALOG), { status: 200 });
      },
    };

    const catalog = await fetchModelsDevCatalog(http, "https://models.test/api.json");
    expect(calls).toBe(3);
    expect(catalog.anthropic?.name).toBe("Anthropic");
  });

  test("throws after exhausting retries on persistent failure", async () => {
    let calls = 0;
    const http: HttpClient = {
      fetch: async () => {
        calls += 1;
        return new Response("boom", { status: 500 });
      },
    };

    await expect(fetchModelsDevCatalog(http, "https://models.test/api.json")).rejects.toThrow(/500/);
    expect(calls).toBe(3);
  });
});

describe("sortModels", () => {
  test("newest release first, then id descending as a stable tiebreaker", () => {
    const sorted = sortModels([
      model({ id: "zeta", family: "a", releaseDate: "2026-06-01" }),
      model({ id: "gpt-5-mini", family: "openai", releaseDate: "2026-01-01" }),
      model({ id: "gemini-3-pro", family: "google", releaseDate: "2026-03-01" }),
      model({ id: "alpha", family: "a", releaseDate: "2026-07-01" }),
    ]);

    expect(sorted.map((m) => m.id)).toEqual(["alpha", "zeta", "gemini-3-pro", "gpt-5-mini"]);
  });

  test("ties break by id descending for a stable order", () => {
    const sorted = sortModels([
      model({ id: "model-a", family: "x", releaseDate: "2026-01-01" }),
      model({ id: "model-b", family: "x", releaseDate: "2026-01-01" }),
    ]);
    expect(sorted.map((m) => m.id)).toEqual(["model-b", "model-a"]);
  });
});

describe("defaultModelIDs", () => {
  test("picks the best model per family by the sort order", () => {
    const defaults = defaultModelIDs([
      model({ id: "claude-old", family: "anthropic", releaseDate: "2025-01-01" }),
      model({ id: "claude-new", family: "anthropic", releaseDate: "2026-06-01" }),
      model({ id: "gpt-5.2", family: "openai", releaseDate: "2026-04-01" }),
      model({ id: "gpt-5-mini", family: "openai", releaseDate: "2026-05-01" }),
    ]);

    expect(defaults.anthropic).toBe("claude-new");
    expect(defaults.openai).toBe("gpt-5-mini");
  });

  test("the newest release wins, with no hardcoded priority prefixes", () => {
    const defaults = defaultModelIDs([
      model({ id: "gpt-5.2", family: "openai", releaseDate: "2026-04-01" }),
      model({ id: "o9-ultra", family: "openai", releaseDate: "2026-08-01" }),
    ]);
    expect(defaults.openai).toBe("o9-ultra");
  });
});

describe("mergeCatalogWithConfig", () => {
  const catalog = [
    model({ id: "gpt-5.2", family: "openai", name: "GPT-5.2", contextWindow: 400_000 }),
    model({ id: "claude-opus-5", family: "anthropic", name: "Claude Opus 5" }),
  ];

  test("a config model under a known provider overrides only stated fields", () => {
    const merged = mergeCatalogWithConfig(catalog, {
      openai: { models: { "gpt-5.2": { contextWindow: 500_000 } } },
    });

    const gpt = merged.find((m) => m.id === "gpt-5.2");
    expect(gpt?.contextWindow).toBe(500_000);
    expect(gpt?.name).toBe("GPT-5.2"); // inherited
    expect(gpt?.pricing.inputPerMTok).toBe(1); // inherited
  });

  test("an unknown model id under a known provider is added bare", () => {
    const merged = mergeCatalogWithConfig(catalog, {
      openai: { models: { "gpt-6-preview": { name: "GPT-6 Preview" } } },
    });

    const added = merged.find((m) => m.id === "gpt-6-preview");
    expect(added?.family).toBe("openai");
    expect(added?.name).toBe("GPT-6 Preview");
    expect(added?.contextWindow).toBe(0); // bare until curated
  });

  test("a brand-new provider is defined by its models entries alone", () => {
    const merged = mergeCatalogWithConfig(catalog, {
      "my-gateway": {
        models: { "llama-4": { name: "Llama 4", contextWindow: 128_000 } },
      },
    });

    const llama = merged.find((m) => m.id === "llama-4");
    expect(llama?.family).toBe("my-gateway");
    expect(llama?.contextWindow).toBe(128_000);
  });

  test("a config provider with no models still exists so it can show connected", () => {
    const merged = mergeCatalogWithConfig(catalog, { "my-gateway": {} });
    expect(merged.some((m) => m.family === "my-gateway")).toBe(true);
  });

  test("no config means the catalog passes through untouched", () => {
    expect(mergeCatalogWithConfig(catalog, undefined)).toEqual(catalog);
  });
});

describe("filterModels", () => {
  const models = [
    model({ id: "gpt-5.2", family: "openai" }),
    model({ id: "claude-opus-5", family: "anthropic" }),
    model({ id: "claude-old", family: "anthropic", status: "deprecated" }),
    model({ id: "llama-4", family: "my-gateway" }),
  ];

  test("disabled_providers removes a family entirely", () => {
    const filtered = filterModels(models, { disabledProviders: ["anthropic"] });
    expect(filtered.some((m) => m.family === "anthropic")).toBe(false);
    expect(filtered.some((m) => m.family === "openai")).toBe(true);
  });

  test("enabled_providers keeps only the listed families", () => {
    const filtered = filterModels(models, { enabledProviders: ["openai"] });
    expect(filtered.map((m) => m.family)).toEqual(["openai"]);
  });

  test("deprecated models are dropped unless explicitly included", () => {
    expect(filterModels(models).some((m) => m.id === "claude-old")).toBe(false);
    expect(filterModels(models, { includeDeprecated: true }).some((m) => m.id === "claude-old")).toBe(true);
  });

  test("per-provider whitelist and blacklist filter model ids", () => {
    const whitelisted = filterModels(models, { providers: { anthropic: { whitelist: ["claude-opus-5"] } } });
    expect(whitelisted.some((m) => m.id === "claude-old")).toBe(false);
    expect(whitelisted.some((m) => m.id === "claude-opus-5")).toBe(true);

    const blacklisted = filterModels(models, { providers: { openai: { blacklist: ["gpt-5.2"] } } });
    expect(blacklisted.some((m) => m.id === "gpt-5.2")).toBe(false);
  });
});
