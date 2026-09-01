import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HttpClient } from "@agency/net";
import { isStale, loadCachedCatalog, loadModelRegistry, saveCachedCatalog } from "../src/catalog-cache.ts";
import { ModelRegistry } from "../src/registry.ts";

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
