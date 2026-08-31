import { describe, expect, test } from "bun:test";
import type { HttpClient } from "@agency/net";
import { ModelRegistry } from "../src/registry.ts";

describe("ModelRegistry", () => {
  test("lists the built-in catalog, optionally filtered by family", () => {
    const registry = new ModelRegistry();
    expect(registry.list().length).toBeGreaterThan(0);
    expect(registry.list("anthropic").every((m) => m.family === "anthropic")).toBe(true);
  });

  test("get returns a known model with pricing and capability data", () => {
    const registry = new ModelRegistry();
    const model = registry.get("claude-opus-5");
    expect(model?.family).toBe("anthropic");
    expect(model?.pricing.inputPerMTok).toBeGreaterThan(0);
    expect(model?.capabilities.tools).toBe(true);
  });

  test("returns undefined for an unknown model id", () => {
    expect(new ModelRegistry().get("not-a-real-model")).toBeUndefined();
  });

  test("refresh adds a brand-new OpenAI model bare, without touching known entries", async () => {
    const registry = new ModelRegistry();
    const http: HttpClient = {
      fetch: async () =>
        new Response(JSON.stringify({ data: [{ id: "gpt-5.2" }, { id: "gpt-5.3-preview" }] }), { status: 200 }),
    };

    await registry.refresh("openai", http, "sk-test");

    const known = registry.get("gpt-5.2");
    expect(known?.pricing.inputPerMTok).toBe(5); // untouched, kept curated pricing

    const brandNew = registry.get("gpt-5.3-preview");
    expect(brandNew).toBeDefined();
    expect(brandNew?.family).toBe("openai");
    expect(brandNew?.pricing.inputPerMTok).toBe(0); // bare until curated
  });

  test("refresh strips the models/ prefix Google returns", async () => {
    const registry = new ModelRegistry([]);
    const http: HttpClient = {
      fetch: async () =>
        new Response(JSON.stringify({ models: [{ name: "models/gemini-3-flash" }] }), { status: 200 }),
    };

    await registry.refresh("google", http, "key-test");

    expect(registry.get("gemini-3-flash")).toBeDefined();
    expect(registry.get("models/gemini-3-flash")).toBeUndefined();
  });
});
