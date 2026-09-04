import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HttpClient } from "@agency/net";
import { CATALOG_FRESH_TTL_MS } from "../src/catalog/models-dev.ts";
import {
  CATALOG_TTL_MS,
  isStale,
  loadCachedCatalog,
  loadCanonicalCatalog,
  loadModelRegistry,
  refreshCatalog,
  saveCachedCatalog,
} from "../src/catalog-cache.ts";
import { type ModelInfo, ModelRegistry } from "../src/registry.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "agency-catalog-cache-"));
  dirs.push(dir);
  return dir;
}

describe("save/loadCachedCatalog", () => {
  test("round-trips the registry's model list", () => {
    const dir = setup();
    const registry = new ModelRegistry();
    saveCachedCatalog(dir, registry.list());

    const cached = loadCachedCatalog(dir);
    expect(cached?.models.map((m) => m.id)).toEqual(registry.list().map((m) => m.id));
  });

  test("returns undefined when nothing is cached yet", () => {
    expect(loadCachedCatalog(setup())).toBeUndefined();
  });
});

describe("isStale", () => {
  test("true past the TTL, false within it", () => {
    const fresh = { savedAt: new Date().toISOString(), models: [] };
    const old = { savedAt: new Date(Date.now() - 10_000).toISOString(), models: [] };
    expect(isStale(fresh, 60_000)).toBe(false);
    expect(isStale(old, 5_000)).toBe(true);
  });

  test("a single canonical TTL governs the cache (no 24h shadow window)", () => {
    expect(CATALOG_TTL_MS).toBe(CATALOG_FRESH_TTL_MS);
  });
});

describe("loadCanonicalCatalog", () => {
  test("offline falls back to the builtin snapshot and persists it", async () => {
    const dir = setup();
    const http: HttpClient = {
      fetch: async () => {
        throw new Error("offline");
      },
    };
    const result = await loadCanonicalCatalog({ cacheDir: dir, http });
    expect(result.source).toBe("builtin");
    expect(result.models.length).toBeGreaterThan(0);
    expect(loadCachedCatalog(dir)?.models.length).toBe(result.models.length);
  });

  test("live ids for every family merge over the catalog without dropping curated data", async () => {
    const dir = setup();
    const http: HttpClient = {
      fetch: async (url: string) => {
        if (typeof url === "string" && url.includes("generativelanguage")) {
          return new Response(JSON.stringify({ models: [{ name: "models/gemini-3-flash" }] }), {
            status: 200,
          });
        }
        return new Response(JSON.stringify({ data: [{ id: "brand-new-1" }] }), { status: 200 });
      },
    };
    const result = await loadCanonicalCatalog({
      cacheDir: dir,
      http,
      env: { OPENCODE_DISABLE_MODELS_FETCH: "1" },
      refresh: [
        { family: "openai", http, apiKey: "k" },
        { family: "google", http, apiKey: "k" },
      ],
    });
    expect(result.models.some((m) => m.id === "brand-new-1" && m.family === "openai")).toBe(true);
    expect(result.models.some((m) => m.id === "gemini-3-flash" && m.family === "google")).toBe(true);
    expect(result.models.some((m) => m.id === "claude-opus-5")).toBe(true);
  });
});

describe("loadModelRegistry", () => {
  test("seeds from a fresh cache without refreshing", async () => {
    const dir = setup();
    saveCachedCatalog(dir, [
      {
        id: "custom-model",
        family: "custom",
        contextWindow: 1,
        maxOutputTokens: 1,
        pricing: { inputPerMTok: 0, outputPerMTok: 0 },
        capabilities: { tools: false, vision: false, thinking: false },
      },
    ]);

    let called = false;
    const http: HttpClient = {
      fetch: async () => {
        called = true;
        return new Response("{}");
      },
    };
    const registry = await loadModelRegistry({
      cacheDir: dir,
      refresh: [{ family: "custom", http, apiKey: "k" }],
    });

    expect(called).toBe(false);
    expect(registry.get("custom-model")?.family).toBe("custom");
  });

  test("refreshes when stale and persists the result", async () => {
    const dir = setup();
    saveCachedCatalog(dir, []);
    writeFileSync(
      join(dir, "model-catalog.json"),
      JSON.stringify({ savedAt: new Date(0).toISOString(), models: [] }),
    );

    const http: HttpClient = {
      fetch: async () => new Response(JSON.stringify({ data: [{ id: "gpt-5.2" }] }), { status: 200 }),
    };
    const registry = await loadModelRegistry({
      cacheDir: dir,
      ttlMs: 1,
      refresh: [{ family: "openai", http, apiKey: "k" }],
    });

    expect(registry.get("gpt-5.2")).toBeDefined();
    const persisted = JSON.parse(readFileSync(join(dir, "model-catalog.json"), "utf8"));
    expect(persisted.models.some((m: { id: string }) => m.id === "gpt-5.2")).toBe(true);
  });

  test("a failed refresh keeps serving the stale cache instead of throwing", async () => {
    const dir = setup();
    writeFileSync(
      join(dir, "model-catalog.json"),
      JSON.stringify({
        savedAt: new Date(0).toISOString(),
        models: [
          {
            id: "stale-model",
            family: "openai",
            contextWindow: 1,
            maxOutputTokens: 1,
            pricing: { inputPerMTok: 0, outputPerMTok: 0 },
            capabilities: { tools: false, vision: false, thinking: false },
          },
        ],
      }),
    );

    const http: HttpClient = {
      fetch: async () => {
        throw new Error("offline");
      },
    };
    const registry = await loadModelRegistry({
      cacheDir: dir,
      ttlMs: 1,
      refresh: [{ family: "openai", http, apiKey: "k" }],
    });

    expect(registry.get("stale-model")).toBeDefined();
  });
});

function model(overrides: Partial<ModelInfo> & Pick<ModelInfo, "id" | "family">): ModelInfo {
  return {
    contextWindow: 100_000,
    maxOutputTokens: 8_000,
    pricing: { inputPerMTok: 1, outputPerMTok: 2 },
    capabilities: { tools: true, vision: false, thinking: false },
    ...overrides,
  };
}

describe("refreshCatalog", () => {
  test("builtin-only: returns builtin models when no other sources", () => {
    const builtin = [model({ id: "gpt-5.2", family: "openai", name: "GPT-5.2" })];
    const result = refreshCatalog({ builtin, modelsDev: [], liveIds: {} });
    expect(result).toHaveLength(1);
    expect(result[0]?.id).toBe("gpt-5.2");
    expect(result[0]?.name).toBe("GPT-5.2");
  });

  test("models.dev overlays builtin: same id+family in both, models.dev wins", () => {
    const builtin = [model({ id: "gpt-5.2", family: "openai", name: "GPT-5.2", contextWindow: 400_000 })];
    const modelsDev = [
      model({ id: "gpt-5.2", family: "openai", name: "GPT-5.2 Updated", contextWindow: 500_000 }),
    ];
    const result = refreshCatalog({ builtin, modelsDev, liveIds: {} });
    expect(result).toHaveLength(1);
    expect(result[0]?.name).toBe("GPT-5.2 Updated");
    expect(result[0]?.contextWindow).toBe(500_000);
  });

  test("live IDs add brand-new models bare without overwriting known ones", () => {
    const builtin = [
      model({
        id: "gpt-5.2",
        family: "openai",
        name: "GPT-5.2",
        pricing: { inputPerMTok: 5, outputPerMTok: 20 },
      }),
    ];
    const result = refreshCatalog({
      builtin,
      modelsDev: [],
      liveIds: { openai: ["gpt-5.2", "gpt-5.3-preview"] },
    });
    expect(result).toHaveLength(2);

    const known = result.find((m) => m.id === "gpt-5.2");
    expect(known?.pricing.inputPerMTok).toBe(5);

    const brandNew = result.find((m) => m.id === "gpt-5.3-preview");
    expect(brandNew).toBeDefined();
    expect(brandNew?.family).toBe("openai");
    expect(brandNew?.pricing.inputPerMTok).toBe(0);
    expect(brandNew?.capabilities.tools).toBe(false);
  });

  test("same model id in different families are separate entries", () => {
    const builtin = [
      model({ id: "flash", family: "openai", name: "OpenAI Flash" }),
      model({ id: "flash", family: "google", name: "Google Flash" }),
    ];
    const result = refreshCatalog({ builtin, modelsDev: [], liveIds: {} });
    expect(result).toHaveLength(2);
    expect(result.filter((m) => m.id === "flash")).toHaveLength(2);
  });

  test("empty sources produce empty result", () => {
    const result = refreshCatalog({ builtin: [], modelsDev: [], liveIds: {} });
    expect(result).toEqual([]);
  });

  test("all 3 sources reconciled with correct priority", () => {
    const builtin = [
      model({ id: "claude-opus-5", family: "anthropic", name: "Claude Opus 5", contextWindow: 200_000 }),
      model({ id: "gpt-5.2", family: "openai", name: "GPT-5.2", contextWindow: 400_000 }),
    ];
    const modelsDev = [
      model({ id: "claude-opus-5", family: "anthropic", name: "Claude Opus 5", contextWindow: 250_000 }),
      model({ id: "gemini-3-pro", family: "google", name: "Gemini 3 Pro", contextWindow: 1_000_000 }),
    ];
    const liveIds = {
      openai: ["gpt-5.2", "o9-ultra"],
      anthropic: ["claude-opus-5", "claude-sonnet-5"],
    };

    const result = refreshCatalog({ builtin, modelsDev, liveIds });

    const opus = result.find((m) => m.id === "claude-opus-5");
    expect(opus?.contextWindow).toBe(250_000);

    const gpt = result.find((m) => m.id === "gpt-5.2");
    expect(gpt?.contextWindow).toBe(400_000);

    const gemini = result.find((m) => m.id === "gemini-3-pro");
    expect(gemini?.contextWindow).toBe(1_000_000);

    const o9 = result.find((m) => m.id === "o9-ultra");
    expect(o9?.family).toBe("openai");
    expect(o9?.contextWindow).toBe(0);

    const sonnet = result.find((m) => m.id === "claude-sonnet-5");
    expect(sonnet?.family).toBe("anthropic");
    expect(sonnet?.contextWindow).toBe(0);

    expect(result).toHaveLength(5);
  });

  test("models.dev model with different family than builtin is treated as separate", () => {
    const builtin = [model({ id: "flash", family: "openai", name: "OpenAI Flash" })];
    const modelsDev = [model({ id: "flash", family: "google", name: "Google Flash" })];
    const result = refreshCatalog({ builtin, modelsDev, liveIds: {} });
    expect(result).toHaveLength(2);
    expect(result.find((m) => m.family === "openai")?.name).toBe("OpenAI Flash");
    expect(result.find((m) => m.family === "google")?.name).toBe("Google Flash");
  });
});
