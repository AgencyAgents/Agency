import { afterEach, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BoardStore, EventBus } from "@agency/core";
import { Redactor } from "@agency/guard";
import type { HttpClient } from "@agency/net";
import type { KeychainBackend, ProviderAdapter, StreamEvent } from "@agency/providers";
import { type ModelInfo, Scheduler } from "@agency/providers";
import type { MethodHandler } from "@agency/rpc";
import { connectToDaemon, type DaemonClient } from "@agency/rpc";
import { registerTeamHandlers } from "../src/daemon/handlers/team.ts";
import { createTeamContext, type TeamContext } from "../src/daemon/team-context.ts";
import type { DaemonContext } from "../src/daemon.ts";
import { type AgentDaemon, createAgentDaemon, type RunTurnRpcResult } from "../src/daemon.ts";

const noopHttp: HttpClient = { fetch: async () => new Response() };
const daemons: AgentDaemon[] = [];
const clients: DaemonClient[] = [];
const dirs: string[] = [];

afterEach(async () => {
  for (const c of clients.splice(0)) await c.close().catch(() => {});
  for (const d of daemons.splice(0)) await d.stop().catch(() => {});
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

function writeConfigDir(config: Record<string, unknown>): string {
  const dir = tempDir("agency-dp52-cfg-");
  writeFileSync(join(dir, "config.jsonc"), JSON.stringify({ schemaVersion: 2, ...config }));
  return dir;
}

const PRICED_MODEL = "claude-sonnet-5";
const USAGE = { inputTokens: 1000, outputTokens: 500 };
const HANDLES = ["w1", "w2", "w3", "w4", "w5"];

function teamCfg(): Record<string, unknown> {
  const agents: Record<string, unknown> = {
    leader: {
      role: "GeneralDispatcher",
      provider: "anthropic",
      model: PRICED_MODEL,
      effort: "low",
      enabled: true,
    },
  };
  for (const h of HANDLES) {
    agents[h] = { role: "Worker", provider: "anthropic", model: PRICED_MODEL, effort: "low", enabled: true };
  }
  return { agents };
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Tracks concurrent stream entries so tests can prove parallel (not serial) spawn. */
function parallelAdapter(state: {
  active: number;
  maxActive: number;
  childBriefs: string[];
}): ProviderAdapter {
  return {
    family: "fake",
    async *stream(request): AsyncIterable<StreamEvent> {
      state.active++;
      state.maxActive = Math.max(state.maxActive, state.active);
      try {
        const msgs = request.messages;
        const hasToolResult = msgs.some((m) =>
          m.content.some((b) => (b as { type: string }).type === "tool_result"),
        );
        const lastUser = [...msgs].reverse().find((m) => m.role === "user");
        const txt =
          (
            lastUser?.content.find((b) => (b as { type: string }).type === "text") as
              | { text?: string }
              | undefined
          )?.text ?? "";
        if (!hasToolResult && txt === "please dispatch five") {
          yield { type: "tool_call_start", id: "c1", name: "dispatch" };
          yield {
            type: "tool_call_delta",
            id: "c1",
            inputJsonDelta: JSON.stringify({
              agents: HANDLES.map((h) => ({ handle: h, brief: `brief for ${h}` })),
            }),
          };
          yield { type: "tool_call_end", id: "c1" };
          yield { type: "message_stop", stopReason: "tool_use", usage: { ...USAGE } };
          return;
        }
        if (txt.startsWith("brief for ")) {
          state.childBriefs.push(txt);
          // Stagger so completion order differs from input order; the barrier
          // must still report results in input order. Base delay dwarfs the
          // pre-stream setup stagger so all five overlap in stream().
          const idx = HANDLES.findIndex((h) => txt === `brief for ${h}`);
          await sleep(500 + (HANDLES.length - idx) * 80);
          yield { type: "text_delta", text: `child output for ${txt}` };
          yield { type: "message_stop", stopReason: "end_turn", usage: { ...USAGE } };
          return;
        }
        if (txt.includes("compare prompt")) {
          await sleep(300);
          yield { type: "text_delta", text: "compare output" };
          yield { type: "message_stop", stopReason: "end_turn", usage: { ...USAGE } };
          return;
        }
        yield { type: "text_delta", text: "parent done" };
        yield { type: "message_stop", stopReason: "end_turn", usage: { ...USAGE } };
      } finally {
        state.active--;
      }
    },
  };
}

function toolResultText(result: RunTurnRpcResult): string {
  const msg = result.messages.find(
    (m) => m.role === "user" && m.content.some((b) => b.type === "tool_result"),
  );
  const block = msg?.content.find((b) => b.type === "tool_result") as { content?: string } | undefined;
  return block?.content ?? "";
}

async function startDaemon(state: { active: number; maxActive: number; childBriefs: string[] }) {
  const root = tempDir("agency-dp52-root-");
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["config", "user.email", "qa@example.com"], { cwd: root });
  execFileSync("git", ["config", "user.name", "qa"], { cwd: root });
  writeFileSync(join(root, "app.ts"), "export const v = 1;\n");
  execFileSync("git", ["add", "."], { cwd: root });
  execFileSync("git", ["commit", "-qm", "init"], { cwd: root });
  const sessionsDir = tempDir("agency-dp52-sess-");
  const daemon = await createAgentDaemon({
    workspaceRoot: root,
    instanceFile: join(tempDir("agency-dp52-inst-"), "instance.json"),
    adapterFor: () => parallelAdapter(state),
    http: noopHttp,
    configDir: writeConfigDir(teamCfg()),
    sessionsDir,
  });
  daemons.push(daemon);
  const client = await connectToDaemon(daemon.server.port, "127.0.0.1", { token: daemon.server.token });
  clients.push(client);
  return { client };
}

describe("daemon parallel specialists (item 52)", () => {
  it("dispatch tool runs 5 specialists in parallel with ordered lean results", async () => {
    const state = { active: 0, maxActive: 0, childBriefs: [] as string[] };
    const { client } = await startDaemon(state);
    const result = (await client.call("run_turn", {
      turnId: "dp52-parent",
      provider: "anthropic",
      model: PRICED_MODEL,
      apiKey: "key",
      systemPrompt: "sys",
      session: [{ role: "user", content: [{ type: "text", text: "please dispatch five" }] }],
      sessionId: "dp52-parent-session",
    })) as RunTurnRpcResult;
    expect(result.stopReason).toBe("end_turn");
    // True parallel spawn: all five child turns overlap.
    expect(state.maxActive).toBe(5);
    expect(state.childBriefs.length).toBe(5);
    // Lean context: each child receives only its short brief, never a history.
    for (const brief of state.childBriefs) {
      expect(brief.length).toBeLessThanOrEqual(2000);
      expect(brief).toMatch(/^brief for w[1-5]$/);
    }
    const text = toolResultText(result);
    const lines = text.split("\n").filter(Boolean);
    expect(lines.length).toBe(5);
    // Promise barrier keeps input order even though w5 finishes first.
    for (let i = 0; i < HANDLES.length; i++) {
      expect(lines[i]).toContain(HANDLES[i]!);
      expect(lines[i]).not.toContain("\n");
    }
    const agents = (await client.call("agents_list", {})) as Array<{
      handle: string;
      state: string;
      costUsd: number;
    }>;
    for (const h of HANDLES) {
      const a = agents.find((x) => x.handle === h)!;
      expect(a.state).toBe("idle");
      expect(a.costUsd).toBeGreaterThan(0);
    }
  });

  it("dispatch_compare runs 5 specialists in parallel with ordered results", async () => {
    const state = { active: 0, maxActive: 0, childBriefs: [] as string[] };
    const { client } = await startDaemon(state);
    const res = (await client.call("dispatch_compare", {
      handles: [...HANDLES],
      prompt: "compare prompt five",
    })) as { results: Array<{ handle: string; result: string }> };
    expect(res.results.length).toBe(5);
    expect(state.maxActive).toBe(5);
    // Ordered by input handles, not by completion order.
    expect(res.results.map((r) => r.handle)).toEqual(HANDLES);
    for (const r of res.results) {
      expect(r.result).toContain(r.handle);
    }
  });
});

const UNIT_PROVIDER = "unitprov";

// Sends the pre-resolved apiKey first, so tests can assert exactly what the
// per-child turn received without touching a real provider credential.
function keyCaptureAdapter(state: { apiKeys: string[] }): ProviderAdapter {
  return {
    family: "fake",
    async *stream(request): AsyncIterable<StreamEvent> {
      state.apiKeys.push(request.apiKey);
      yield { type: "text_delta", text: "compare output" };
      yield { type: "message_stop", stopReason: "end_turn", usage: { inputTokens: 10, outputTokens: 5 } };
    },
  };
}

// Runs the real dispatch_compare handler with a stubbed keychain, so the
// pre-resolve-to-child mapping across team.ts and team-run.ts is exercised
// end to end while keychain call counts stay observable.
function compareHandlerHarness(opts: {
  keychainGet: (key: string) => Promise<string | undefined>;
  keychainThrows?: boolean;
}) {
  const apiKeys: string[] = [];
  const redactor = new Redactor();
  let chainCalls = 0;
  const keychain: KeychainBackend = {
    name: "test",
    async isAvailable() {
      return true;
    },
    async get(key) {
      if (opts.keychainThrows) throw new Error("keychain unavailable");
      return opts.keychainGet(key);
    },
    async set() {},
    async delete() {},
  };
  const teamContexts = new Map<string, TeamContext>();
  const teamFor = (id: string): TeamContext => {
    let team = teamContexts.get(id);
    if (!team) {
      team = createTeamContext(id);
      teamContexts.set(id, team);
    }
    return team;
  };
  const boardStore = new BoardStore();
  const agent = {
    handle: "w1",
    role: "Worker",
    provider: UNIT_PROVIDER,
    model: PRICED_MODEL,
    effort: "low",
    sessionId: "team-w1",
    mailbox: [],
  };
  const modelInfo: ModelInfo = {
    id: PRICED_MODEL,
    family: UNIT_PROVIDER,
    contextWindow: 200000,
    maxOutputTokens: 32000,
    pricing: { inputPerMTok: 3, outputPerMTok: 15, cachedInputPerMTok: 0.3, cacheWritePerMTok: 3.75 },
    capabilities: { tools: true, vision: false, thinking: true },
    status: "active",
  };
  const ctx = {
    activeControllers: new Map<string, AbortController>(),
    approvalManagers: new Map(),
    boardStore,
    broadcast: () => {},
    capabilitiesForAgent: () => ({ tools: "*", pathScopes: "*", network: "*" }),
    catalogModel: (p: string, m: string) =>
      p === UNIT_PROVIDER && m === PRICED_MODEL ? modelInfo : undefined,
    channelStore: { read: () => ({ posts: [], cursor: 0 }) },
    choiceLog: { digest: () => [] },
    config: {},
    createTraceRecorder: () => undefined,
    eventBus: new EventBus(),
    gateForAgent: () => ({ toolOffered: () => true }),
    getKeychain: async () => {
      chainCalls += 1;
      return keychain;
    },
    getOrCreateScope: async () => ({}),
    http: noopHttp,
    logger: {},
    options: { workspaceRoot: tempDir("agency-dp52-unit-root-") },
    providers: {},
    redactor,
    schedulerFor: () => new Scheduler({ maxConcurrent: 2 }),
    sessionScopes: new Map(),
    spendLedger: { record: () => {} },
    teamContexts,
    teamFor,
    teamRegistry: { get: () => agent, list: () => [agent] },
    todoSessionsDir: tempDir("agency-dp52-unit-sess-"),
    todoStore: { load: () => [], latestTip: () => undefined, append: async () => {}, create: () => {} },
    warnPersistence: () => {},
    adapterFor: () => keyCaptureAdapter({ apiKeys }),
  } as unknown as DaemonContext;
  const handlers: Record<string, MethodHandler> = {};
  registerTeamHandlers(handlers, ctx);
  return {
    dispatchCompare: handlers.dispatch_compare!,
    apiKeys,
    redactor,
    keychainCalls: () => chainCalls,
  };
}

describe("dispatch_compare pre-resolve key mapping (item 52)", () => {
  it("uses a pre-resolved found key verbatim and registers it as a secret", async () => {
    const key = "unit-key-dp52-found-0123456789abcdef";
    const { dispatchCompare, apiKeys, redactor, keychainCalls } = compareHandlerHarness({
      keychainGet: async (name) => (name === UNIT_PROVIDER ? key : undefined),
    });
    const res = (await dispatchCompare(
      { handles: [...HANDLES], prompt: "compare prompt found" },
      { clientId: "test" },
    )) as {
      results: Array<{ handle: string; result: string }>;
    };
    expect(res.results.length).toBe(HANDLES.length);
    // The single pre-resolve hit the keychain, then every child used it
    // verbatim with no per-child keychain fallback.
    expect(keychainCalls()).toBe(1);
    expect(apiKeys).toHaveLength(HANDLES.length);
    expect(apiKeys.every((k) => k === key)).toBe(true);
    // The found key became a redactor secret in the pre-resolve step.
    expect(redactor.redact(key)).toBe("[REDACTED]");
  });

  it("a pre-resolved miss (empty string) skips all keychain calls and runs keyless", async () => {
    const { dispatchCompare, apiKeys, keychainCalls } = compareHandlerHarness({
      keychainGet: async () => undefined,
    });
    const res = (await dispatchCompare(
      { handles: [...HANDLES], prompt: "compare prompt miss" },
      { clientId: "test" },
    )) as {
      results: Array<{ handle: string; result: string }>;
    };
    expect(res.results.length).toBe(HANDLES.length);
    // One keychain hit for the pre-resolve, zero per-child fallback calls.
    expect(keychainCalls()).toBe(1);
    expect(apiKeys).toHaveLength(HANDLES.length);
    // The empty-string miss flows through to the child as a visible keyless run.
    expect(apiKeys.every((k) => k === "")).toBe(true);
  });

  it("an undefined pre-resolve preserves the per-child keychain fallback", async () => {
    // A throwing keychain aborts the batched pre-resolve, leaving the provider
    // absent from compareKeys; each child then re-enters the per-child fallback
    // that the found and miss paths skip.
    const { dispatchCompare, apiKeys, keychainCalls } = compareHandlerHarness({
      keychainGet: async () => undefined,
      keychainThrows: true,
    });
    const res = (await dispatchCompare(
      { handles: [...HANDLES], prompt: "compare prompt fallback" },
      { clientId: "test" },
    )) as {
      results: Array<{ handle: string; result: string }>;
    };
    expect(res.results.length).toBe(HANDLES.length);
    // Pre-resolve (1) plus one per-child fallback per handle.
    expect(keychainCalls()).toBe(1 + HANDLES.length);
    expect(apiKeys).toHaveLength(HANDLES.length);
    expect(apiKeys.every((k) => k === "")).toBe(true);
  });
});
