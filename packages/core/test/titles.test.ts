import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HttpClient } from "@agency/net";
import type { ProviderAdapter, StreamEvent } from "@agency/providers";
import type { Config } from "../src/config/schema.ts";
import { SessionStore } from "../src/sessions/store.ts";
import { generateTitle, getSessionTitle, resolveSmallModel } from "../src/sessions/titles.ts";

const noopHttp: HttpClient = { fetch: async () => new Response() };

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "agency-titles-"));
  dirs.push(dir);
  return { store: new SessionStore(dir), dir };
}

/** A mock adapter that returns a fixed title text. */
function mockTitleAdapter(title: string): ProviderAdapter {
  return {
    family: "fake",
    async *stream(): AsyncIterable<StreamEvent> {
      yield { type: "text_delta", text: title };
      yield { type: "message_stop", stopReason: "end_turn", usage: { inputTokens: 5, outputTokens: 3 } };
    },
  };
}

/** A mock adapter that throws on stream. */
function failingAdapter(): ProviderAdapter {
  return {
    family: "fake",
    // biome-ignore lint/correctness/useYield: mock that intentionally throws
    async *stream(): AsyncIterable<StreamEvent> {
      throw new Error("stream failed");
    },
  };
}

const baseConfig: Config = {
  small_model: "openai/gpt-4o-mini",
  provider: {},
  model: "openai/gpt-4o",
} as unknown as Config;

const configNoSmall: Config = {
  provider: {},
  model: "openai/gpt-4o",
} as unknown as Config;

const providerConfig = {
  openai: { family: "openai" as const, apiKey: "sk-test" },
};

describe("resolveSmallModel", () => {
  test("returns provider/model from small_model config", () => {
    const ref = resolveSmallModel(baseConfig);
    expect(ref).toEqual({ provider: "openai", model: "gpt-4o-mini" });
  });

  test("returns undefined when small_model is not set", () => {
    expect(resolveSmallModel(configNoSmall)).toBeUndefined();
  });
});

describe("generateTitle", () => {
  test("returns title from mock adapter", async () => {
    const title = await generateTitle("Hello, can you help me with my project?", {
      config: baseConfig,
      http: noopHttp,
      apiKey: "sk-test",
      providerConfig,
      adapterFor: () => mockTitleAdapter("Project Help"),
    });
    expect(title).toBe("Project Help");
  });

  test("returns undefined when no small_model configured", async () => {
    const title = await generateTitle("Hello world", {
      config: configNoSmall,
      http: noopHttp,
      apiKey: "sk-test",
      providerConfig,
      adapterFor: () => mockTitleAdapter("Hello"),
    });
    expect(title).toBeUndefined();
  });

  test("returns undefined when user message is empty", async () => {
    const title = await generateTitle("", {
      config: baseConfig,
      http: noopHttp,
      apiKey: "sk-test",
      providerConfig,
      adapterFor: () => mockTitleAdapter("Hello"),
    });
    expect(title).toBeUndefined();
  });

  test("returns undefined when user message is only whitespace", async () => {
    const title = await generateTitle("   \n  \t  ", {
      config: baseConfig,
      http: noopHttp,
      apiKey: "sk-test",
      providerConfig,
      adapterFor: () => mockTitleAdapter("Hello"),
    });
    expect(title).toBeUndefined();
  });

  test("returns undefined when adapter throws", async () => {
    const title = await generateTitle("Hello world", {
      config: baseConfig,
      http: noopHttp,
      apiKey: "sk-test",
      providerConfig,
      adapterFor: () => failingAdapter(),
    });
    expect(title).toBeUndefined();
  });

  test("trims and cleans title output", async () => {
    const title = await generateTitle("Hello world", {
      config: baseConfig,
      http: noopHttp,
      apiKey: "sk-test",
      providerConfig,
      adapterFor: () => mockTitleAdapter("\n  My Project Title  \n"),
    });
    expect(title).toBe("My Project Title");
  });

  test("uses the first line only", async () => {
    const title = await generateTitle("Hello world", {
      config: baseConfig,
      http: noopHttp,
      apiKey: "sk-test",
      providerConfig,
      adapterFor: () => mockTitleAdapter("Line One\nLine Two"),
    });
    expect(title).toBe("Line One");
  });

  test("caps title at 80 chars", async () => {
    const long = "A".repeat(100);
    const title = await generateTitle("Hello world", {
      config: baseConfig,
      http: noopHttp,
      apiKey: "sk-test",
      providerConfig,
      adapterFor: () => mockTitleAdapter(long),
    });
    expect(title).toBe("A".repeat(80));
    expect(title!.length).toBe(80);
  });
});

describe("getSessionTitle", () => {
  test("returns latest title from entries", () => {
    // biome-ignore lint/suspicious/noExplicitAny: test data
    const entries: any[] = [
      {
        type: "session_title",
        title: "First",
        id: "1",
        parentId: null,
        schemaVersion: 1,
        createdAt: "2026-01-01",
      },
      { type: "message", id: "2", parentId: "1", schemaVersion: 1, createdAt: "2026-01-02" },
      {
        type: "session_title",
        title: "Second",
        id: "3",
        parentId: "2",
        schemaVersion: 1,
        createdAt: "2026-01-03",
      },
    ];
    expect(getSessionTitle(entries)).toBe("Second");
  });

  test("returns undefined when no title entries", () => {
    // biome-ignore lint/suspicious/noExplicitAny: test data
    const entries: any[] = [{ type: "message", id: "1", parentId: null, schemaVersion: 1, createdAt: "" }];
    expect(getSessionTitle(entries)).toBeUndefined();
  });

  test("returns undefined for empty entries", () => {
    expect(getSessionTitle([])).toBeUndefined();
  });

  test("returns title when only one title entry exists", () => {
    // biome-ignore lint/suspicious/noExplicitAny: test data
    const entries: any[] = [
      {
        type: "session_title",
        title: "Only Title",
        id: "1",
        parentId: null,
        schemaVersion: 1,
        createdAt: "2026-01-01",
      },
    ];
    expect(getSessionTitle(entries)).toBe("Only Title");
  });
});

describe("SessionStore integration with titles", () => {
  test("session list shows title when session_title entry exists", async () => {
    const { store } = setup();
    const meta = store.create("s1");
    const e1 = await store.append(meta.id, {
      type: "message",
      parentId: null,
      message: { role: "user", content: [{ type: "text", text: "hi" }] },
    });
    await store.append(meta.id, { type: "session_title", parentId: e1.id, title: "My Session" });

    const entries = store.load(meta.id);
    expect(getSessionTitle(entries)).toBe("My Session");
  });

  test("session list falls back to no title when no session_title entry", async () => {
    const { store } = setup();
    const meta = store.create("s2");
    await store.append(meta.id, {
      type: "message",
      parentId: null,
      message: { role: "user", content: [{ type: "text", text: "hi" }] },
    });

    const entries = store.load(meta.id);
    expect(getSessionTitle(entries)).toBeUndefined();
  });

  test("multiple sessions each have independent titles", async () => {
    const { store } = setup();
    const s1 = store.create("s1");
    const s2 = store.create("s2");

    const e1 = await store.append(s1.id, {
      type: "message",
      parentId: null,
      message: { role: "user", content: [{ type: "text", text: "first" }] },
    });
    await store.append(s1.id, { type: "session_title", parentId: e1.id, title: "Session One" });

    const e2 = await store.append(s2.id, {
      type: "message",
      parentId: null,
      message: { role: "user", content: [{ type: "text", text: "second" }] },
    });
    await store.append(s2.id, { type: "session_title", parentId: e2.id, title: "Session Two" });

    expect(getSessionTitle(store.load("s1"))).toBe("Session One");
    expect(getSessionTitle(store.load("s2"))).toBe("Session Two");
  });

  test("title survives across load cycles (persisted to disk)", async () => {
    const { store, dir } = setup();
    const meta = store.create("persist-test");
    const e1 = await store.append(meta.id, {
      type: "message",
      parentId: null,
      message: { role: "user", content: [{ type: "text", text: "hi" }] },
    });
    await store.append(meta.id, { type: "session_title", parentId: e1.id, title: "Persisted Title" });

    // Create a new store instance reading the same directory
    const store2 = new SessionStore(dir);
    expect(getSessionTitle(store2.load("persist-test"))).toBe("Persisted Title");
  });
});
