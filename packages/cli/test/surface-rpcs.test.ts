import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { type Config, dataDir, memoryFile, SessionStore, type ToolSpec } from "@agency/core";
import type { HttpClient } from "@agency/net";
import {
  type KeychainBackend,
  type ModelInfo,
  type ProviderAdapter,
  type ProviderRequest,
  type StreamEvent,
  saveCachedCatalog,
  saveModelsDevCatalog,
} from "@agency/providers";
import { connectToDaemon, type DaemonClient } from "@agency/rpc";
import { type AgentDaemon, createAgentDaemon } from "../src/daemon.ts";
import { listProviders } from "../src/providers-list.ts";

const noopHttp: HttpClient = { fetch: async () => new Response() };
const daemons: AgentDaemon[] = [];
const clients: DaemonClient[] = [];
const dirs: string[] = [];

const home = mkdtempSync(join(tmpdir(), "agency-surface-home-"));
const prevHome = process.env.AGENCY_HOME;
const prevKey = process.env.AGENCY_ANTHROPIC_API_KEY;
beforeAll(() => {
  process.env.AGENCY_HOME = home;
  process.env.AGENCY_ANTHROPIC_API_KEY = "test-key-surface";
});
afterAll(() => {
  if (prevHome === undefined) delete process.env.AGENCY_HOME;
  else process.env.AGENCY_HOME = prevHome;
  if (prevKey === undefined) delete process.env.AGENCY_ANTHROPIC_API_KEY;
  else process.env.AGENCY_ANTHROPIC_API_KEY = prevKey;
  rmSync(home, { recursive: true, force: true });
});
afterEach(async () => {
  for (const client of clients.splice(0)) await client.close();
  for (const daemon of daemons.splice(0)) await daemon.stop();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function model(id: string, family: string): ModelInfo {
  return {
    id,
    family,
    name: id,
    providerName: family,
    contextWindow: 100_000,
    maxOutputTokens: 8_000,
    pricing: { inputPerMTok: 1, outputPerMTok: 2 },
    capabilities: { tools: true, vision: false, thinking: false },
    releaseDate: "2026-01-01",
  };
}

function fakeKeychain(keys: Record<string, string>): KeychainBackend {
  return {
    name: "fake",
    isAvailable: async () => true,
    set: async () => {},
    get: async (account) => keys[account],
    delete: async () => {},
  };
}

async function startDaemon(overrides: Partial<Parameters<typeof createAgentDaemon>[0]> = {}) {
  const workspaceRoot = mkdtempSync(join(tmpdir(), "agency-surface-ws-"));
  const sessionsDir = mkdtempSync(join(tmpdir(), "agency-surface-sess-"));
  dirs.push(workspaceRoot, sessionsDir);
  const daemon = await createAgentDaemon({
    workspaceRoot,
    instanceFile: join(workspaceRoot, ".agency", "instance.json"),
    sessionsDir,
    adapterFor: () => textAdapter(),
    http: noopHttp,
    ...overrides,
  });
  daemons.push(daemon);
  const client = await connectToDaemon(daemon.server.port, "127.0.0.1", { token: daemon.server.token });
  clients.push(client);
  return { daemon, client, workspaceRoot, sessionsDir };
}

function textAdapter(): ProviderAdapter {
  return {
    family: "fake",
    async *stream(): AsyncIterable<StreamEvent> {
      yield { type: "text_delta", text: "hi" };
      yield { type: "message_stop", stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1 } };
    },
  };
}

const sendParams = (sessionId: string, turnId: string) => ({
  turnId,
  sessionId,
  provider: "anthropic",
  model: "test-model",
  systemPrompt: "sys",
  userText: "hello",
});

describe("providers_list models: connected", () => {
  const catalog = [model("m-a", "alpha"), model("m-b", "beta"), model("m-c", "gamma")];
  const config = { provider: { gamma: {} }, disabled_providers: [] } as unknown as Config;

  test("lists models only for connected or configured providers", async () => {
    const options = {
      config,
      http: noopHttp,
      catalog,
      env: {},
      keychain: fakeKeychain({ alpha: "key" }),
    };
    const slim = await listProviders({ ...options, models: "connected" });
    expect(slim.all.map((p) => [p.id, p.name])).toEqual([
      ["alpha", "alpha"],
      ["beta", "beta"],
      ["gamma", "gamma"],
    ]);
    expect(Object.fromEntries(slim.all.map((p) => [p.id, p.models.map((m) => m.id)]))).toEqual({
      alpha: ["m-a"],
      beta: [],
      gamma: ["m-c"],
    });
    expect(slim.connected).toEqual(["alpha"]);
    expect(slim.all[0]?.models[0]).toMatchObject({
      pricing: { inputPerMTok: 1, outputPerMTok: 2 },
      capabilities: { tools: true },
      releaseDate: "2026-01-01",
    });

    const full = await listProviders(options);
    expect(full.all.find((p) => p.id === "beta")?.models.map((m) => m.id)).toEqual(["m-b"]);
  });

  test("the daemon lists with its own keychain", async () => {
    const { client } = await startDaemon({
      catalog,
      keychain: fakeKeychain({ beta: "key" }),
    });
    const result = (await client.call("providers_list", { models: "connected" })) as {
      all: Array<{ id: string; models: unknown[] }>;
      connected: string[];
    };
    expect(result.connected).toEqual(["beta"]);
    expect(result.all.find((p) => p.id === "beta")?.models).toHaveLength(1);
    expect(result.all.find((p) => p.id === "alpha")?.models).toEqual([]);
  });

  test("the provider of the default model lists its models with no key, and a bad models value is refused", async () => {
    const slim = await listProviders({
      config: { ...config, model: "beta/m-b" } as Config,
      http: noopHttp,
      catalog,
      env: {},
      keychain: fakeKeychain({}),
      models: "connected",
    });
    expect(slim.all.find((p) => p.id === "beta")?.models.map((m) => m.id)).toEqual(["m-b"]);
    expect(slim.all.find((p) => p.id === "alpha")?.models).toEqual([]);

    const { client } = await startDaemon({ catalog });
    await expect(client.call("providers_list", { models: "some" })).rejects.toThrow('"all" or "connected"');
  });
});

describe("session_title_set", () => {
  test("appends a title that session_list shows", async () => {
    const { client } = await startDaemon();
    await client.call("session_send", sendParams("title-s1", "title-t1"));
    const before = (await client.call("session_list", {})) as {
      sessions: Array<{ id: string; title?: string }>;
    };
    expect(before.sessions.find((s) => s.id === "title-s1")?.title).toBe("hello");

    const result = await client.call("session_title_set", {
      sessionId: "title-s1",
      title: "  Fix the build  ",
    });
    expect(result).toEqual({ sessionId: "title-s1", title: "Fix the build" });
    const after = (await client.call("session_list", {})) as {
      sessions: Array<{ id: string; title?: string }>;
    };
    expect(after.sessions.find((s) => s.id === "title-s1")?.title).toBe("Fix the build");
  });

  test("refuses an empty, an overlong, or an unknown-session title", async () => {
    const { client } = await startDaemon();
    await client.call("session_send", sendParams("title-s2", "title-t2"));
    for (const title of ["   ", "x".repeat(201)]) {
      const error = await client.call("session_title_set", { sessionId: "title-s2", title }).catch((e) => e);
      expect((error as { code?: string }).code).toBe("invalid_request");
    }
    const unknown = await client.call("session_title_set", { sessionId: "nope", title: "t" }).catch((e) => e);
    expect((unknown as { code?: string }).code).toBe("invalid_request");
    const ok = await client.call("session_title_set", { sessionId: "title-s2", title: "x".repeat(200) });
    expect((ok as { title: string }).title).toHaveLength(200);
  });
});

describe("memory_get and memory_remove", () => {
  test("memory_get reads the notes of the workspace, empty when the file is missing", async () => {
    const { client, workspaceRoot } = await startDaemon();
    const path = memoryFile(workspaceRoot);
    expect(await client.call("memory_get", {})).toEqual({ enabled: true, path, notes: [] });

    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "- one\n\n- two\n");
    expect(await client.call("memory_get", {})).toEqual({ enabled: true, path, notes: ["- one", "- two"] });
  });

  test("memory_remove drops the first exactly matching line only", async () => {
    const { client, workspaceRoot } = await startDaemon();
    const path = memoryFile(workspaceRoot);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "- one\n- two\n- one\n- one more\n");

    expect(await client.call("memory_remove", { note: "- one" })).toEqual({
      removed: true,
      notes: ["- two", "- one", "- one more"],
    });
    expect(readFileSync(path, "utf8")).toBe("- two\n- one\n- one more\n");
    // A part of a line is not a match.
    expect(await client.call("memory_remove", { note: "two" })).toEqual({
      removed: false,
      notes: ["- two", "- one", "- one more"],
    });
  });
});

describe("session_delete", () => {
  test("refuses a session that runs a turn, and deletes it once the turn ends", async () => {
    let release = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const adapter: ProviderAdapter = {
      family: "fake",
      async *stream(): AsyncIterable<StreamEvent> {
        await gate;
        yield { type: "text_delta", text: "done" };
        yield { type: "message_stop", stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1 } };
      },
    };
    const { client } = await startDaemon({ adapterFor: () => adapter });
    const sending = client.call("session_send", sendParams("del-s1", "del-t1"));
    await new Promise((r) => setTimeout(r, 200));
    await expect(client.call("session_delete", { sessionId: "del-s1" })).rejects.toThrow("runs a turn");
    release();
    await sending;
    expect(await client.call("session_delete", { sessionId: "del-s1" })).toMatchObject({ deleted: true });
  }, 15_000);
});

describe("reasoning levels of the catalog", () => {
  test("providers_list lists them and a turn passes them to the adapter with the level", async () => {
    const requests: ProviderRequest[] = [];
    const adapter: ProviderAdapter = {
      family: "fake",
      async *stream(request): AsyncIterable<StreamEvent> {
        requests.push(request);
        yield { type: "text_delta", text: "hi" };
        yield { type: "message_stop", stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1 } };
      },
    };
    const base: ModelInfo = {
      ...model("test-model", "anthropic"),
      capabilities: { tools: true, vision: false, thinking: true },
    };
    const thinker: ModelInfo = { ...base, efforts: ["low", "xhigh", "max"] };
    // The turn reads the base catalog; only the levels come from the models.dev cache.
    const cache = join(dataDir(), "cache");
    saveCachedCatalog(cache, [base]);
    saveModelsDevCatalog(cache, [thinker]);
    try {
      const { client } = await startDaemon({ catalog: [thinker], adapterFor: () => adapter });
      const list = (await client.call("providers_list", { models: "all" })) as {
        all: Array<{ id: string; models: Array<{ id: string; efforts?: string[] }> }>;
      };
      const listed = list.all.find((p) => p.id === "anthropic")?.models.find((m) => m.id === "test-model");
      expect(listed?.efforts).toEqual(["low", "xhigh", "max"]);

      await client.call("session_send", { ...sendParams("eff-s1", "eff-t1"), thinkingLevel: "xhigh" });
      expect(requests.at(-1)).toMatchObject({
        thinkingLevel: "xhigh",
        efforts: ["low", "xhigh", "max"],
        maxTokens: 8000,
      });
    } finally {
      rmSync(cache, { recursive: true, force: true });
    }
  }, 15_000);
});

describe("turn timing", () => {
  test("session_send, the usage entry and turn_complete carry ttft, stream time and output tokens", async () => {
    const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
    let calls = 0;
    const adapter: ProviderAdapter = {
      family: "fake",
      async *stream(): AsyncIterable<StreamEvent> {
        calls += 1;
        if (calls === 1) {
          await wait(100);
          yield { type: "text_delta", text: "a" };
          await wait(60);
          yield { type: "text_delta", text: "b" };
          yield { type: "tool_call_start", id: "c1", name: "note" };
          yield { type: "tool_call_end", id: "c1" };
          yield { type: "message_stop", stopReason: "tool_use", usage: { inputTokens: 5, outputTokens: 7 } };
          return;
        }
        // A slow second request: the turn's ttft is the first request's, not the sum or the last.
        await wait(600);
        yield { type: "text_delta", text: "c" };
        await wait(60);
        yield { type: "text_delta", text: "d" };
        yield { type: "message_stop", stopReason: "end_turn", usage: { inputTokens: 5, outputTokens: 5 } };
      },
    };
    const noteTool: ToolSpec = {
      name: "note",
      description: "Records a note.",
      inputSchema: { type: "object", properties: {} },
      riskTier: "safe",
      handler: async () => ({ content: "noted" }),
    };
    const { client, sessionsDir } = await startDaemon({ adapterFor: () => adapter, tools: [noteTool] });
    const events: Array<{ type: string; timing?: { ttftMs: number; streamMs: number } }> = [];
    client.on("turn.time-t1", (payload) => events.push(payload as (typeof events)[number]));

    const result = (await client.call("session_send", sendParams("time-s1", "time-t1"))) as {
      timing?: { ttftMs: number; streamMs: number; outputTokens: number };
    };

    expect(result.timing?.ttftMs).toBeGreaterThanOrEqual(90);
    expect(result.timing?.ttftMs).toBeLessThan(500);
    expect(result.timing?.streamMs).toBeGreaterThanOrEqual(100);
    expect(result.timing?.outputTokens).toBe(12);

    const entry = new SessionStore(sessionsDir)
      .load("time-s1")
      .find((e) => e.type === "usage") as unknown as { timing?: unknown };
    expect(entry.timing).toEqual(result.timing);

    const completes = events.filter((e) => e.type === "turn_complete");
    expect(completes).toHaveLength(2);
    expect(completes[0]?.timing?.ttftMs).toBeGreaterThanOrEqual(90);
    expect(completes[1]?.timing?.ttftMs).toBeGreaterThanOrEqual(590);
  }, 15_000);

  test("a request that streams only a tool call starts its stream at the tool call", async () => {
    const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
    let calls = 0;
    const adapter: ProviderAdapter = {
      family: "fake",
      async *stream(): AsyncIterable<StreamEvent> {
        calls += 1;
        if (calls === 1) {
          await wait(80);
          yield { type: "tool_call_start", id: "c1", name: "note" };
          await wait(300);
          yield { type: "tool_call_end", id: "c1" };
          yield { type: "message_stop", stopReason: "tool_use", usage: { inputTokens: 5, outputTokens: 3 } };
          return;
        }
        yield { type: "text_delta", text: "done" };
        yield { type: "message_stop", stopReason: "end_turn", usage: { inputTokens: 5, outputTokens: 1 } };
      },
    };
    const noteTool: ToolSpec = {
      name: "note",
      description: "Records a note.",
      inputSchema: { type: "object", properties: {} },
      riskTier: "safe",
      handler: async () => ({ content: "noted" }),
    };
    const { client } = await startDaemon({ adapterFor: () => adapter, tools: [noteTool] });
    const events: Array<{ type: string; timing?: { ttftMs: number; streamMs: number } }> = [];
    client.on("turn.tool-t1", (payload) => events.push(payload as (typeof events)[number]));
    await client.call("session_send", sendParams("tool-s1", "tool-t1"));

    const first = events.find((e) => e.type === "turn_complete")?.timing;
    expect(first?.ttftMs).toBeLessThan(300);
    expect(first?.streamMs).toBeGreaterThanOrEqual(250);
  }, 15_000);

  test("a turn cancelled before any output reports no timing", async () => {
    const adapter: ProviderAdapter = {
      family: "fake",
      async *stream(request): AsyncIterable<StreamEvent> {
        await new Promise((r) => request.signal?.addEventListener("abort", r, { once: true }));
        if (request.signal?.aborted) throw new DOMException("aborted", "AbortError");
        yield { type: "text_delta", text: "late" };
      },
    };
    const { client, sessionsDir } = await startDaemon({ adapterFor: () => adapter });
    const events: Array<{ type: string; timing?: unknown }> = [];
    client.on("turn.cancel-t1", (payload) => events.push(payload as (typeof events)[number]));
    const sending = client.call("session_send", sendParams("cancel-s1", "cancel-t1"));
    await new Promise((r) => setTimeout(r, 200));
    expect(await client.call("cancel_turn", { turnId: "cancel-t1" })).toEqual({ cancelled: true });
    const result = (await sending) as { stopReason: string; timing?: unknown };

    expect(result.stopReason).toBe("cancelled");
    expect(result.timing).toBeUndefined();
    const completes = events.filter((e) => e.type === "turn_complete");
    expect(completes.length).toBeGreaterThan(0);
    expect(completes.every((e) => e.timing === undefined)).toBe(true);
    const usage = new SessionStore(sessionsDir).load("cancel-s1").find((e) => e.type === "usage") as
      | { timing?: unknown }
      | undefined;
    expect(usage?.timing).toBeUndefined();
  }, 15_000);
});
