import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolSpec } from "@agency/core";
import type { HttpClient } from "@agency/net";
import type { ModelInfo, ProviderAdapter, StreamEvent } from "@agency/providers";
import { connectToDaemon, type DaemonClient } from "@agency/rpc";
import type { RunTurnParams } from "../src/daemon.ts";
import {
  type AgentDaemon,
  createAgentDaemon,
  DEFAULT_SYSTEM_PROMPT,
  type RunTurnRpcResult,
  resolveAdapter,
  resolveSystemPrompt,
} from "../src/daemon.ts";

const noopHttp: HttpClient = { fetch: async () => new Response() };

const daemons: AgentDaemon[] = [];
const clients: DaemonClient[] = [];
const dirs: string[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) await client.close();
  for (const daemon of daemons.splice(0)) await daemon.stop();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempInstanceFile(): string {
  const dir = mkdtempSync(join(tmpdir(), "agency-daemon-test-"));
  dirs.push(dir);
  return join(dir, "instance.json");
}

function textAdapter(text: string, capture?: { systems: string[] }): ProviderAdapter {
  return {
    family: "fake",
    async *stream(request) {
      capture?.systems.push(request.system ?? "");
      yield { type: "text_delta", text };
      yield { type: "message_stop", stopReason: "end_turn", usage: { inputTokens: 3, outputTokens: 2 } };
    },
  };
}

async function startFakeDaemon(overrides: Partial<Parameters<typeof createAgentDaemon>[0]> = {}) {
  const daemon = await createAgentDaemon({
    workspaceRoot: "/repo/fake",
    instanceFile: tempInstanceFile(),
    adapterFor: () => textAdapter("hello from the daemon"),
    http: noopHttp,
    ...overrides,
  });
  daemons.push(daemon);
  const client = await connectToDaemon(daemon.server.port, "127.0.0.1", { token: daemon.server.token });
  clients.push(client);
  return { daemon, client };
}

describe("createAgentDaemon", () => {
  test("run_turn drives a real turn through the loop and returns the result over RPC", async () => {
    const { client } = await startFakeDaemon();

    const result = (await client.call("run_turn", {
      turnId: "t1",
      provider: "anthropic",
      model: "test-model",
      apiKey: "key",
      systemPrompt: "sys",
      session: [],
    })) as RunTurnRpcResult;

    expect(result.stopReason).toBe("end_turn");
    expect(result.cancelled).toBe(false);
    expect(result.messages[0]).toMatchObject({
      role: "assistant",
      content: [{ type: "text", text: "hello from the daemon" }],
    });
  });

  test("turn events are broadcast under a per-turn event name", async () => {
    const { client } = await startFakeDaemon();
    const events: unknown[] = [];
    client.on("turn.t2", (payload) => events.push(payload));

    await client.call("run_turn", {
      turnId: "t2",
      provider: "anthropic",
      model: "test-model",
      apiKey: "key",
      systemPrompt: "sys",
      session: [],
    });

    expect(events).toContainEqual({ type: "text_delta", text: "hello from the daemon" });
  });

  test("cancel_turn aborts a run_turn that's using a tool respecting the signal", async () => {
    let sawAbort = false;
    const slowTool: ToolSpec = {
      name: "slow",
      description: "waits for cancellation",
      inputSchema: {},
      handler: (_input, ctx) =>
        new Promise((resolve) => {
          ctx.signal.addEventListener("abort", () => {
            sawAbort = true;
            resolve({ content: "aborted", isError: true });
          });
        }),
    };

    let call = 0;
    const toolThenDone: ProviderAdapter = {
      family: "fake",
      async *stream(): AsyncIterable<StreamEvent> {
        call += 1;
        if (call === 1) {
          yield { type: "tool_call_start", id: "c1", name: "slow" };
          yield { type: "tool_call_delta", id: "c1", inputJsonDelta: "{}" };
          yield { type: "tool_call_end", id: "c1" };
          yield { type: "message_stop", stopReason: "tool_use", usage: { inputTokens: 1, outputTokens: 1 } };
        } else {
          yield { type: "text_delta", text: "done" };
          yield { type: "message_stop", stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1 } };
        }
      },
    };

    const { client } = await startFakeDaemon({ adapterFor: () => toolThenDone, tools: [slowTool] });

    const runPromise = client.call("run_turn", {
      turnId: "t3",
      provider: "anthropic",
      model: "test-model",
      apiKey: "key",
      systemPrompt: "sys",
      session: [],
    });

    await new Promise((r) => setTimeout(r, 50));
    const cancelResult = await client.call("cancel_turn", { turnId: "t3" });
    await runPromise;

    expect(cancelResult).toEqual({ cancelled: true });
    expect(sawAbort).toBe(true);
  });

  test("cancel_turn for an unknown turnId reports not cancelled instead of erroring", async () => {
    const { client } = await startFakeDaemon();
    const result = await client.call("cancel_turn", { turnId: "does-not-exist" });
    expect(result).toEqual({ cancelled: false });
  });

  test("an unknown provider surfaces as a rejected call, not a crashed daemon", async () => {
    const { client } = await startFakeDaemon({ adapterFor: undefined });

    // await expect(...).rejects.toThrow(...) loses this socket-driven rejection
    // under bun 1.4 (unhandled between tests); an awaited try/catch is the same
    // assertion without tripping that.
    let rejection: string | undefined;
    try {
      await client.call("run_turn", {
        turnId: "t4",
        provider: "not-a-real-provider",
        model: "x",
        apiKey: "key",
        systemPrompt: "sys",
        session: [],
      });
    } catch (error) {
      rejection = error instanceof Error ? error.message : String(error);
    }
    expect(rejection).toMatch(/unknown provider/);

    // The daemon itself must still be alive after that rejection.
    expect(await client.call("cancel_turn", { turnId: "whatever" })).toEqual({ cancelled: false });
  });

  test("onIdleShutdown fires after the last client disconnects and the linger elapses", async () => {
    let shutdownCalled = false;
    const { daemon, client } = await startFakeDaemon({
      idleLingerMs: 30,
      onIdleShutdown: () => {
        shutdownCalled = true;
      },
    });

    await client.close();
    clients.length = 0; // already closed, don't close again in afterEach
    await new Promise((r) => setTimeout(r, 100));

    expect(shutdownCalled).toBe(true);
    void daemon;
  });

  test("onIdleShutdown does not fire while a client is still connected", async () => {
    let shutdownCalled = false;
    await startFakeDaemon({ idleLingerMs: 30, onIdleShutdown: () => (shutdownCalled = true) });

    await new Promise((r) => setTimeout(r, 100));
    expect(shutdownCalled).toBe(false);
  });

  test("providers_list returns catalog groups, defaults, and connected ids over RPC", async () => {
    const catalog: ModelInfo[] = [
      {
        id: "gpt-5.2",
        family: "openai",
        name: "GPT-5.2",
        providerName: "OpenAI",
        contextWindow: 400_000,
        maxOutputTokens: 128_000,
        pricing: { inputPerMTok: 5, outputPerMTok: 20 },
        capabilities: { tools: true, vision: true, thinking: true },
        releaseDate: "2026-04-01",
      },
      {
        id: "free-model",
        family: "my-gateway",
        name: "Free Model",
        providerName: "My Gateway",
        contextWindow: 128_000,
        maxOutputTokens: 8_000,
        pricing: { inputPerMTok: 0, outputPerMTok: 0 },
        capabilities: { tools: false, vision: false, thinking: false },
      },
    ];

    const { client } = await startFakeDaemon({
      catalog,
      configDir: writeConfigDir({
        provider: { "my-gateway": { env: ["MY_GATEWAY_KEY"] } },
      }),
    });

    const previousKey = process.env.MY_GATEWAY_KEY;
    process.env.MY_GATEWAY_KEY = "test-key-123";
    let result: {
      all: Array<{ id: string; name: string; models: Array<{ id: string; name: string }> }>;
      default: Record<string, string>;
      connected: string[];
    };
    try {
      result = (await client.call("providers_list", {})) as typeof result;
    } finally {
      if (previousKey === undefined) delete process.env.MY_GATEWAY_KEY;
      else process.env.MY_GATEWAY_KEY = previousKey;
    }

    const gateway = result.all.find((p) => p.id === "my-gateway");
    expect(gateway?.name).toBe("My Gateway");
    expect(gateway?.models.map((m) => m.id)).toContain("free-model");
    expect(result.default.openai).toBe("gpt-5.2");
    // MY_GATEWAY_KEY is set in this process's env, so the gateway counts as connected.
    expect(result.connected).toContain("my-gateway");
  }, 30_000);

  test("providers_list honors disabled_providers from config", async () => {
    const { client } = await startFakeDaemon({
      catalog: [catalogModel("gpt-5.2", "openai"), catalogModel("claude-opus-5", "anthropic")],
      configDir: writeConfigDir({ disabled_providers: ["anthropic"] }),
    });

    const result = (await client.call("providers_list", {})) as {
      all: Array<{ id: string }>;
    };
    expect(result.all.some((p) => p.id === "anthropic")).toBe(false);
    expect(result.all.some((p) => p.id === "openai")).toBe(true);
  }, 30_000);
});

describe("system prompt composition", () => {
  test("a plain systemPrompt string is used as the base, with the environment block appended", async () => {
    const capture = { systems: [] as string[] };
    const { client } = await startFakeDaemon({ adapterFor: () => textAdapter("ok", capture) });

    await client.call("run_turn", {
      turnId: "sys-1",
      provider: "anthropic",
      model: "test-model",
      apiKey: "key",
      systemPrompt: "sys",
      session: [],
    });

    expect(capture.systems).toHaveLength(1);
    const system = capture.systems[0] ?? "";
    expect(system.startsWith("sys\n\n")).toBe(true);
    expect(system).toContain("<environment>");
    expect(system).toContain("cwd: /repo/fake");
    expect(system).toContain("date: ");
    expect(system).not.toContain("git: branch");
  });

  test("systemPromptParts compose identity, role, instructions, and context in order", async () => {
    const capture = { systems: [] as string[] };
    const { client } = await startFakeDaemon({ adapterFor: () => textAdapter("ok", capture) });

    await client.call("run_turn", {
      turnId: "sys-2",
      provider: "anthropic",
      model: "test-model",
      apiKey: "key",
      systemPrompt: "raw-string-ignored",
      systemPromptParts: {
        identity: "IDENTITY",
        role: "ROLE",
        instructions: ["INSTR1", "INSTR2"],
      },
      session: [],
    });

    const system = capture.systems[0] ?? "";
    const order = [
      system.indexOf("IDENTITY"),
      system.indexOf("ROLE"),
      system.indexOf("INSTR1"),
      system.indexOf("<environment>"),
    ];
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(system).not.toContain("raw-string-ignored");
  });

  test("systemReminders apply only on the turn that sends them", async () => {
    const capture = { systems: [] as string[] };
    const { client } = await startFakeDaemon({ adapterFor: () => textAdapter("ok", capture) });

    const baseParams = {
      provider: "anthropic",
      model: "test-model",
      apiKey: "key",
      systemPrompt: "sys",
      session: [],
    };
    await client.call("run_turn", { ...baseParams, turnId: "rem-1" });
    await client.call("run_turn", {
      ...baseParams,
      turnId: "rem-2",
      systemReminders: [{ kind: "file_changed", text: "src/x.ts changed on disk" }],
    });

    expect(capture.systems).toHaveLength(2);
    expect(capture.systems[0]).not.toContain("<system-reminder>");
    expect(capture.systems[1]).toContain(
      "<system-reminder>\n- [file_changed] src/x.ts changed on disk\n</system-reminder>",
    );
  });

  test("parts.context=false omits the environment block", async () => {
    const capture = { systems: [] as string[] };
    const { client } = await startFakeDaemon({ adapterFor: () => textAdapter("ok", capture) });

    await client.call("run_turn", {
      turnId: "sys-3",
      provider: "anthropic",
      model: "test-model",
      apiKey: "key",
      systemPrompt: "sys",
      systemPromptParts: { context: false },
      session: [],
    });

    expect(capture.systems[0]).toBe("sys");
  });
});

describe("resolveSystemPrompt", () => {
  const params = (overrides: Partial<RunTurnParams> = {}): RunTurnParams => ({
    turnId: "t",
    provider: "p",
    model: "m",
    apiKey: "k",
    systemPrompt: "sys",
    session: [],
    ...overrides,
  });

  test("no reminders and no mcp failures means no reminder block", () => {
    const system = resolveSystemPrompt(params(), {
      workspaceRoot: "/repo/fake",
      git: () => null,
    });
    expect(system).not.toContain("<system-reminder>");
  });

  test("mcp start failures become mcp_server_down reminders", () => {
    const system = resolveSystemPrompt(params(), {
      workspaceRoot: "/repo/fake",
      git: () => null,
      mcpFailures: new Map([["fs", "spawn failed"]]),
    });
    expect(system).toContain('- [mcp_server_down] MCP server "fs" is unavailable: spawn failed');
  });

  test("the git seam feeds branch and dirty state into the environment block", () => {
    const system = resolveSystemPrompt(params(), {
      workspaceRoot: "/repo/fake",
      git: (_cwd, args) => (args.includes("status") ? "## main...origin/main\n M a.ts\n" : null),
    });
    expect(system).toContain("git: branch main (dirty, 1 changed file)");
  });

  test("identity falls back to the shared default when parts omit it", () => {
    const system = resolveSystemPrompt(params({ systemPromptParts: { role: "ROLE" } }), {
      workspaceRoot: "/repo/fake",
      git: () => null,
    });
    expect(system.startsWith(`${DEFAULT_SYSTEM_PROMPT}\n\nROLE\n\n<environment>`)).toBe(true);
  });
});

function catalogModel(id: string, family: string): ModelInfo {
  return {
    id,
    family,
    name: id,
    providerName: family,
    contextWindow: 100_000,
    maxOutputTokens: 8_000,
    pricing: { inputPerMTok: 1, outputPerMTok: 2 },
    capabilities: { tools: true, vision: false, thinking: false },
  };
}

function writeConfigDir(config: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), "agency-daemon-config-"));
  dirs.push(dir);
  writeFileSync(join(dir, "config.jsonc"), JSON.stringify({ schemaVersion: 2, ...config }));
  return dir;
}

describe("resolveAdapter", () => {
  test("builtin family ids resolve to their native adapters", () => {
    expect(resolveAdapter("anthropic", {}).family).toBe("anthropic");
    expect(resolveAdapter("openai", {}).family).toBe("openai");
    expect(resolveAdapter("google", {}).family).toBe("google");
  });

  test("a config provider defaults to the openai-compatible adapter at its baseUrl", () => {
    const adapter = resolveAdapter("my-gateway", {
      "my-gateway": { family: "openai-compatible", baseUrl: "http://localhost:8080/v1" },
    });
    expect(adapter.family).toBe("my-gateway");
  });

  test("a config provider can declare a native family instead", () => {
    expect(resolveAdapter("anthropic", { anthropic: { family: "anthropic" } }).family).toBe("anthropic");
  });

  test("a config openai-compatible provider without any baseUrl throws", () => {
    expect(() => resolveAdapter("my-gateway", { "my-gateway": {} })).toThrow(/baseUrl/);
  });

  test("an unknown provider with a catalog base URL gets the compatible adapter", () => {
    const adapter = resolveAdapter("together", {}, { together: "https://api.together.xyz/v1" });
    expect(adapter.family).toBe("together");
  });

  test("a fully unknown provider still throws", () => {
    expect(() => resolveAdapter("not-real", {})).toThrow(/unknown provider/);
  });
});
