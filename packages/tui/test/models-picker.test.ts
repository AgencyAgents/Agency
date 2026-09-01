import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildPickerSections,
  formatContextWindow,
  isGated,
  ModelPickerStore,
  modelBadges,
  modelKey,
  type PickerModel,
  type PickerProvider,
  parseModelKey,
  sortModelOptions,
} from "../src/models-picker.ts";

function pm(overrides: Partial<PickerModel> & Pick<PickerModel, "id" | "providerId">): PickerModel {
  return {
    name: overrides.id,
    providerName: overrides.providerId,
    pricing: { inputPerMTok: 1, outputPerMTok: 2 },
    contextWindow: 128_000,
    capabilities: { tools: true, vision: false, thinking: false },
    ...overrides,
  };
}

const PROVIDERS: PickerProvider[] = [
  {
    id: "openai",
    name: "OpenAI",
    models: [
      pm({
        id: "gpt-5.2",
        providerId: "openai",
        providerName: "OpenAI",
        name: "GPT-5.2",
        releaseDate: "2026-04-01",
      }),
      pm({
        id: "gpt-5-nano",
        providerId: "openai",
        providerName: "OpenAI",
        name: "GPT-5 Nano",
        releaseDate: "2026-05-01",
        pricing: { inputPerMTok: 0, outputPerMTok: 0 },
      }),
      pm({
        id: "gpt-4-old",
        providerId: "openai",
        providerName: "OpenAI",
        name: "GPT-4 Old",
        status: "deprecated",
      }),
    ],
  },
  {
    id: "anthropic",
    name: "Anthropic",
    models: [
      pm({
        id: "claude-opus-5",
        providerId: "anthropic",
        providerName: "Anthropic",
        name: "Claude Opus 5",
        releaseDate: "2026-05-01",
        capabilities: { tools: true, vision: true, thinking: true },
      }),
      pm({
        id: "claude-alpha",
        providerId: "anthropic",
        providerName: "Anthropic",
        name: "Claude Alpha",
        status: "alpha",
      }),
    ],
  },
];

describe("buildPickerSections", () => {
  test("groups models by provider alphabetically, sorted within each group", () => {
    const sections = buildPickerSections(PROVIDERS);
    expect(sections.map((s) => s.label)).toEqual(["Anthropic", "OpenAI"]);
    const openai = sections.find((s) => s.key === "OpenAI");
    // Free first, then newest release first.
    expect(openai?.models.map((m) => m.id)).toEqual(["gpt-5-nano", "gpt-5.2"]);
  });

  test("favorites and recent sections come first when the keys resolve", () => {
    const sections = buildPickerSections(PROVIDERS, {
      favorites: ["anthropic/claude-opus-5"],
      recents: ["openai/gpt-5.2"],
    });
    expect(sections.map((s) => s.key)).toEqual(["favorites", "recent", "Anthropic", "OpenAI"]);
    expect(sections[0]?.models.map((m) => m.id)).toEqual(["claude-opus-5"]);
  });

  test("favorite keys pointing at gated or missing models are dropped", () => {
    const sections = buildPickerSections(PROVIDERS, {
      favorites: ["openai/gpt-4-old", "nope/missing"],
    });
    expect(sections.some((s) => s.key === "favorites")).toBe(false);
  });

  test("deprecated and alpha models are gated out by default", () => {
    const sections = buildPickerSections(PROVIDERS);
    const ids = sections.flatMap((s) => s.models.map((m) => m.id));
    expect(ids).not.toContain("gpt-4-old");
    expect(ids).not.toContain("claude-alpha");
  });

  test("includeGated brings the hidden models back", () => {
    const sections = buildPickerSections(PROVIDERS, { includeGated: true });
    const ids = sections.flatMap((s) => s.models.map((m) => m.id));
    expect(ids).toContain("gpt-4-old");
    expect(ids).toContain("claude-alpha");
  });

  test("a query fuzzy-searches across every provider at once", () => {
    const sections = buildPickerSections(PROVIDERS, { query: "claud opus" });
    expect(sections).toHaveLength(1);
    expect(sections[0]?.models.map((m) => m.id)).toContain("claude-opus-5");
  });

  test("a query also matches on the provider name", () => {
    const sections = buildPickerSections(PROVIDERS, { query: "openai nano" });
    expect(sections[0]?.models.map((m) => m.id)).toContain("gpt-5-nano");
  });

  test("a query with no matches yields an empty results section", () => {
    const sections = buildPickerSections(PROVIDERS, { query: "zzzznothing" });
    expect(sections).toHaveLength(1);
    expect(sections[0]?.models).toEqual([]);
  });
});

describe("sortModelOptions", () => {
  test("free models first, then release date descending, then name", () => {
    const sorted = sortModelOptions([
      pm({ id: "paid-old", providerId: "x", releaseDate: "2026-01-01" }),
      pm({ id: "paid-new", providerId: "x", releaseDate: "2026-06-01" }),
      pm({ id: "free", providerId: "x", pricing: { inputPerMTok: 0, outputPerMTok: 0 } }),
    ]);
    expect(sorted.map((m) => m.id)).toEqual(["free", "paid-new", "paid-old"]);
  });
});

describe("gating and badges", () => {
  test("isGated flags deprecated and alpha only", () => {
    expect(isGated(pm({ id: "a", providerId: "x", status: "deprecated" }))).toBe(true);
    expect(isGated(pm({ id: "a", providerId: "x", status: "alpha" }))).toBe(true);
    expect(isGated(pm({ id: "a", providerId: "x", status: "beta" }))).toBe(false);
    expect(isGated(pm({ id: "a", providerId: "x" }))).toBe(false);
  });

  test("modelBadges leads with Free for zero-cost models and includes ctx", () => {
    const badges = modelBadges(
      pm({
        id: "free",
        providerId: "x",
        pricing: { inputPerMTok: 0, outputPerMTok: 0 },
        contextWindow: 1_000_000,
        capabilities: { tools: true, vision: true, thinking: true },
      }),
    );
    expect(badges[0]).toBe("Free");
    expect(badges).toContain("ctx 1M");
    expect(badges).toContain("tools");
    expect(badges).toContain("vision");
    expect(badges).toContain("thinking");
  });

  test("formatContextWindow scales to k and M", () => {
    expect(formatContextWindow(200_000)).toBe("200k");
    expect(formatContextWindow(1_000_000)).toBe("1M");
    expect(formatContextWindow(1_280_000)).toBe("1.3M");
    expect(formatContextWindow(512)).toBe("512");
  });
});

describe("model keys", () => {
  test("modelKey/parseModelKey round-trip, splitting on the first slash", () => {
    const key = modelKey("openrouter", "openai/gpt-5.2");
    expect(key).toBe("openrouter/openai/gpt-5.2");
    expect(parseModelKey(key)).toEqual({ providerId: "openrouter", modelId: "openai/gpt-5.2" });
    expect(parseModelKey("nonsense")).toBeUndefined();
  });
});

describe("ModelPickerStore", () => {
  test("toggleFavorite adds then removes a key", () => {
    const store = new ModelPickerStore();
    const added = store.toggleFavorite("openai/gpt-5.2");
    expect(added.favorites).toEqual(["openai/gpt-5.2"]);
    const removed = store.toggleFavorite("openai/gpt-5.2");
    expect(removed.favorites).toEqual([]);
  });

  test("recordRecent moves a key to the front and dedupes", () => {
    const store = new ModelPickerStore();
    store.recordRecent("a/1");
    store.recordRecent("b/2");
    store.recordRecent("a/1");
    expect(store.current().recent).toEqual(["a/1", "b/2"]);
  });

  test("recordRecent caps the list at the limit", () => {
    const store = new ModelPickerStore();
    for (let i = 0; i < 15; i++) store.recordRecent(`p/m${i}`);
    expect(store.current().recent).toHaveLength(10);
    expect(store.current().recent[0]).toBe("p/m14");
  });

  test("persists to the given file and reloads from it", () => {
    const dir = mkdtempSync(join(tmpdir(), "agency-picker-test-"));
    try {
      const path = join(dir, "state", "model-recents.json");
      const store = new ModelPickerStore(path);
      store.toggleFavorite("anthropic/claude-opus-5");
      store.recordRecent("openai/gpt-5.2");

      expect(existsSync(path)).toBe(true);
      const reloaded = new ModelPickerStore(path);
      expect(reloaded.current().favorites).toEqual(["anthropic/claude-opus-5"]);
      expect(reloaded.current().recent).toEqual(["openai/gpt-5.2"]);
      expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({
        favorites: ["anthropic/claude-opus-5"],
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a corrupt state file degrades to empty instead of throwing", () => {
    const dir = mkdtempSync(join(tmpdir(), "agency-picker-test-"));
    try {
      const path = join(dir, "model-recents.json");
      writeCorrupt(path);
      const store = new ModelPickerStore(path);
      expect(store.current()).toEqual({ favorites: [], recent: [] });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function writeCorrupt(path: string): void {
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, "{broken");
  }
});
