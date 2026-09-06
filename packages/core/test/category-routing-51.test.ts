import { describe, expect, test } from "bun:test";
import {
  CATEGORY_ROUTES,
  fallbackChainFor,
  filterChainByProviders,
  normalizeCategory,
  routeForCategory,
  runWithCategoryFallback,
  TASK_CATEGORIES,
  temperatureFor,
} from "../src/team/category-routing.ts";

describe("category routing map (item 51)", () => {
  test("covers all five categories with model+temperature", () => {
    expect([...TASK_CATEGORIES].sort()).toEqual(
      [...(["deep", "quick", "ultrabrain", "unspecified", "visual-engineering"] as const)].sort(),
    );
    for (const category of TASK_CATEGORIES) {
      const route = routeForCategory(category);
      expect(route.provider.length).toBeGreaterThan(0);
      expect(route.model.length).toBeGreaterThan(0);
      expect(route.temperature).toBeGreaterThanOrEqual(0);
      expect(route.temperature).toBeLessThanOrEqual(2);
    }
  });

  test("temperatures are optimized per category", () => {
    // Deterministic precision work runs coldest; divergent ultrabrain runs hottest.
    expect(temperatureFor("visual-engineering")).toBe(0.2);
    expect(temperatureFor("ultrabrain")).toBe(0.7);
    expect(temperatureFor("deep")).toBe(0.3);
    expect(temperatureFor("quick")).toBe(0.5);
    expect(temperatureFor("unspecified")).toBe(0.4);
  });

  test("unknown/empty input normalizes to unspecified without throwing", () => {
    expect(normalizeCategory(undefined)).toBe("unspecified");
    expect(normalizeCategory(42)).toBe("unspecified");
    expect(normalizeCategory("nope")).toBe("unspecified");
    expect(normalizeCategory("  DEEP  ")).toBe("deep");
    expect(normalizeCategory("Quick")).toBe("quick");
    expect(routeForCategory("bogus").category).toBe("unspecified");
  });

  test("every fallback chain is cross-provider (no provider repeats)", () => {
    for (const category of TASK_CATEGORIES) {
      const chain = fallbackChainFor(category);
      expect(chain.length).toBeGreaterThanOrEqual(3);
      const providers = chain.map((h) => h.provider.toLowerCase());
      expect(new Set(providers).size).toBe(providers.length);
    }
  });

  test("route map is not mutated by callers", () => {
    const route = routeForCategory("deep");
    route.fallback.push({ provider: "evil", model: "x" });
    expect(CATEGORY_ROUTES.deep.fallback).toHaveLength(2);
    expect(fallbackChainFor("deep")).toHaveLength(3);
  });
});

describe("delegate fallback chains (item 51)", () => {
  test("primary leads the chain, quick stays on the cheap path first", () => {
    const quick = fallbackChainFor("quick");
    expect(quick[0]).toEqual({ provider: "deepseek", model: "deepseek-v4" });
    const visual = fallbackChainFor("visual-engineering");
    expect(visual[0]).toEqual({ provider: "anthropic", model: "claude-sonnet-5" });
  });

  test("filterChainByProviders preserves order and never empties", () => {
    const chain = fallbackChainFor("deep");
    expect(filterChainByProviders(chain, ["google"]).map((h) => h.provider)).toEqual(["google"]);
    expect(filterChainByProviders(chain, ["nope"])).toEqual(chain);
    expect(filterChainByProviders(chain, undefined)).toEqual(chain);
  });

  test("runWithCategoryFallback returns the first success", async () => {
    const seen: string[] = [];
    const result = await runWithCategoryFallback("deep", async (attempt) => {
      seen.push(`${attempt.provider}/${attempt.model}@${attempt.temperature}`);
      if (attempt.attempt === 0) throw new Error("primary down");
      return "recovered";
    });
    expect(result).toBe("recovered");
    expect(seen).toHaveLength(2);
    expect(seen[0]).toBe("openai/gpt-5.2@0.3");
    expect(seen[1]).toBe("anthropic/claude-sonnet-5@0.3");
  });

  test("runWithCategoryFallback throws an aggregate naming every hop", async () => {
    const error = await runWithCategoryFallback("quick", async () => {
      throw new Error("boom");
    }).then(
      () => null,
      (e: Error) => e,
    );
    expect(error).not.toBeNull();
    expect(error!.message).toContain('category "quick" fallback chain exhausted');
    expect(error!.message).toContain("deepseek/deepseek-v4");
    expect(error!.message).toContain("glm/glm-7");
    expect(error!.message).toContain("openai/gpt-5.2");
  });

  test("runWithCategoryFallback honors availableProviders", async () => {
    const tried: string[] = [];
    const result = await runWithCategoryFallback(
      "deep",
      async (attempt) => {
        tried.push(attempt.provider);
        return attempt.provider;
      },
      { availableProviders: ["google"] },
    );
    expect(result).toBe("google");
    expect(tried).toEqual(["google"]);
  });
});
