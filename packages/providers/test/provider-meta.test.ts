import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HttpClient } from "@agency/net";
import { loadModelRegistry, saveCachedCatalog } from "../src/catalog-cache.ts";
import {
  BUILTIN_PROVIDER_METADATA,
  fetchLiveIdsForFamily,
  getProviderMetadata,
  type ModelInfo,
  UnknownProviderError,
} from "../src/registry.ts";

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
  const dir = mkdtempSync(join(tmpdir(), "agency-provider-meta-"));
  dirs.push(dir);
  return dir;
}

function jsonHttp(
  body: unknown,
  status = 200,
  seen?: { url?: string; auth?: string | null; apiKey?: string | null },
): HttpClient {
  return {
    fetch: async (url, init) => {
      if (seen) {
        seen.url = String(url);
        const headers = new Headers(init?.headers);
        seen.auth = headers.get("authorization");
        seen.apiKey = headers.get("x-api-key");
      }
      return new Response(typeof body === "string" ? body : JSON.stringify(body), {
        status,
        statusText: status === 429 ? "Too Many Requests" : "OK",
      });
    },
  };
}

describe("provider metadata snapshot", () => {
  test("existing five families are byte-identical (regression floor)", () => {
    expect(BUILTIN_PROVIDER_METADATA.slice(0, 5)).toEqual([
      {
        id: "anthropic",
        family: "anthropic",
        contextWindow: 200_000,
        costTier: "premium",
        authKinds: ["api-key", "oauth"],
        rateLimit: { requestsPerMinute: 60 },
      },
      {
        id: "openai",
        family: "openai",
        contextWindow: 400_000,
        costTier: "standard",
        authKinds: ["api-key", "oauth"],
        rateLimit: { requestsPerMinute: 500 },
      },
      {
        id: "google",
        family: "google",
        contextWindow: 1_000_000,
        costTier: "standard",
        authKinds: ["api-key", "oauth"],
        rateLimit: { requestsPerMinute: 300 },
      },
      {
        id: "deepseek",
        family: "deepseek",
        contextWindow: 128_000,
        costTier: "cheap",
        authKinds: ["api-key"],
        rateLimit: { requestsPerMinute: 200 },
      },
      {
        id: "glm",
        family: "glm",
        contextWindow: 128_000,
        costTier: "cheap",
        authKinds: ["api-key"],
        rateLimit: { requestsPerMinute: 200 },
      },
    ]);
  });

  test("new families resolve metadata; ollama is keyless with no rate limit", () => {
    expect(getProviderMetadata("openrouter").costTier).toBe("standard");
    expect(getProviderMetadata("groq").costTier).toBe("cheap");
    expect(getProviderMetadata("groq").rateLimit?.requestsPerMinute).toBe(300);
    expect(getProviderMetadata("xai").family).toBe("xai");
    const ollama = getProviderMetadata("ollama");
    expect(ollama.authKinds).toEqual(["none"]);
    expect(ollama.rateLimit).toBeUndefined();
  });

  test("unknown family lookup throws UnknownProviderError naming the id", () => {
    expect(() => getProviderMetadata("not-a-real-provider")).toThrow(UnknownProviderError);
    expect(() => getProviderMetadata("not-a-real-provider")).toThrow("not-a-real-provider");
  });
});

describe("live model ids", () => {
  test("openai uses its default endpoint with bearer auth", async () => {
    const seen: { url?: string; auth?: string | null } = {};
    const ids = await fetchLiveIdsForFamily(
      "openai",
      jsonHttp({ data: [{ id: "gpt-5.2" }] }, 200, seen),
      "sk-test",
    );
    expect(ids).toEqual(["gpt-5.2"]);
    expect(seen.url).toBe("https://api.openai.com/v1/models");
    expect(seen.auth).toBe("Bearer sk-test");
  });

  test("anthropic sends its key headers; google strips the models/ prefix", async () => {
    const seen: { apiKey?: string | null } = {};
    const anthropic = await fetchLiveIdsForFamily(
      "anthropic",
      jsonHttp({ data: [{ id: "claude-opus-5" }] }, 200, seen),
      "sk-ant-test",
    );
    expect(anthropic).toEqual(["claude-opus-5"]);
    expect(seen.apiKey).toBe("sk-ant-test");

    const google = await fetchLiveIdsForFamily(
      "google",
      jsonHttp({ models: [{ name: "models/gemini-3-pro" }] }),
      "key-test",
    );
    expect(google).toEqual(["gemini-3-pro"]);
  });

  test("openrouter, groq, and xai hit their own endpoints; baseUrl overrides", async () => {
    const seen: { url?: string } = {};
    await fetchLiveIdsForFamily("openrouter", jsonHttp({ data: [] }, 200, seen), "k");
    expect(seen.url).toBe("https://openrouter.ai/api/v1/models");
    await fetchLiveIdsForFamily("groq", jsonHttp({ data: [] }, 200, seen), "k");
    expect(seen.url).toBe("https://api.groq.com/openai/v1/models");
    await fetchLiveIdsForFamily("xai", jsonHttp({ data: [] }, 200, seen), "k");
    expect(seen.url).toBe("https://api.x.ai/v1/models");

    await fetchLiveIdsForFamily(
      "openrouter",
      jsonHttp({ data: [] }, 200, seen),
      "k",
      "https://proxy.local/oai/",
    );
    expect(seen.url).toBe("https://proxy.local/oai/models");
  });

  test("ollama reads tags verbatim with a localhost default", async () => {
    const seen: { url?: string } = {};
    const ids = await fetchLiveIdsForFamily(
      "ollama",
      jsonHttp({ models: [{ name: "llama3.1:8b" }] }, 200, seen),
      "",
    );
    expect(ids).toEqual(["llama3.1:8b"]);
    expect(seen.url).toBe("http://localhost:11434/api/tags");

    await fetchLiveIdsForFamily("ollama", jsonHttp({ models: [] }, 200, seen), "", "http://gpu-box:11434");
    expect(seen.url).toBe("http://gpu-box:11434/api/tags");
  });

  test("malformed payloads throw descriptive errors; bad entries are skipped", async () => {
    await expect(fetchLiveIdsForFamily("openai", jsonHttp({}), "k")).rejects.toThrow("malformed payload");
    await expect(fetchLiveIdsForFamily("openai", jsonHttp({ data: null }), "k")).rejects.toThrow(
      "malformed payload",
    );
    await expect(fetchLiveIdsForFamily("openai", jsonHttp("null"), "k")).rejects.toThrow("malformed payload");

    const ids = await fetchLiveIdsForFamily(
      "openai",
      jsonHttp({ data: [{ id: "a" }, { nope: 1 }, { id: 42 }, "x"] }),
      "k",
    );
    expect(ids).toEqual(["a"]);
  });

  test("rate-limited fetch throws naming the family and status", async () => {
    await expect(fetchLiveIdsForFamily("openai", jsonHttp("limited", 429), "k")).rejects.toThrow(
      'live model list for "openai" failed with 429',
    );
  });

  test("unknown family without baseUrl resolves empty; with baseUrl tries OpenAI shape", async () => {
    const seen: { url?: string } = {};
    await expect(fetchLiveIdsForFamily("nope", jsonHttp({ data: [] }), "k")).resolves.toEqual([]);
    const ids = await fetchLiveIdsForFamily(
      "custom-gateway",
      jsonHttp({ data: [{ id: "m1" }] }, 200, seen),
      "k",
      "https://gw.local/v1",
    );
    expect(ids).toEqual(["m1"]);
    expect(seen.url).toBe("https://gw.local/v1/models");
  });
});

describe("rate-limited boot degrades to cache", () => {
  test("forced 429 refresh serves the seeded cache without throwing", async () => {
    const dir = setup();
    const marker: ModelInfo = {
      id: "cached-model",
      family: "openai",
      contextWindow: 100_000,
      maxOutputTokens: 8_000,
      pricing: { inputPerMTok: 1, outputPerMTok: 2 },
      capabilities: { tools: true, vision: false, thinking: false },
    };
    saveCachedCatalog(dir, [marker]);

    const registry = await loadModelRegistry({
      cacheDir: dir,
      ttlMs: 0,
      refresh: [{ family: "openai", http: jsonHttp("limited", 429), apiKey: "k" }],
    });

    expect(registry.get("cached-model")).toBeDefined();
    expect(warnings.join("\n")).toMatch(/openai/);
  });
});
