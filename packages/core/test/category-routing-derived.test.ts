import { describe, expect, test } from "bun:test";
import { BUILTIN_MODELS, type ModelInfo } from "@agency/providers";
import { CATEGORY_ROUTES, resolveCategoryRoutes } from "../src/team/category-routing.ts";

function model(overrides: Partial<ModelInfo> & Pick<ModelInfo, "id" | "family">): ModelInfo {
  return {
    contextWindow: 100_000,
    maxOutputTokens: 8_000,
    pricing: { inputPerMTok: 1, outputPerMTok: 2 },
    capabilities: { tools: true, vision: false, thinking: false },
    ...overrides,
  };
}

describe("resolveCategoryRoutes", () => {
  test("the builtin catalog leaves every pinned hop untouched", () => {
    const resolved = resolveCategoryRoutes(BUILTIN_MODELS);
    expect(resolved).toEqual(CATEGORY_ROUTES);
  });

  test("a hop whose model vanished from the catalog falls back to the family default", () => {
    const catalog = [
      model({ id: "claude-opus-5", family: "anthropic", releaseDate: "2026-05-01" }),
      model({ id: "gpt-5.2", family: "openai", releaseDate: "2026-04-01" }),
    ];
    const resolved = resolveCategoryRoutes(catalog);
    expect(resolved.deep.provider).toBe("openai");
    expect(resolved.deep.model).toBe("gpt-5.2");
    // claude-sonnet-5 is gone: deep's anthropic fallback heals to the family default.
    expect(resolved.deep.fallback[0]).toEqual({ provider: "anthropic", model: "claude-opus-5" });
    // quick's families are absent entirely: hops pass through rather than failing empty.
    expect(resolved.quick.fallback).toHaveLength(2);
  });
});
