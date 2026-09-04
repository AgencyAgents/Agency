import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore, type ToolSpec, TraceRecorder } from "@agency/core";
import type { HttpClient } from "@agency/net";
import type { ModelInfo, ProviderAdapter, StreamEvent } from "@agency/providers";
import { connectToDaemon, type DaemonClient } from "@agency/rpc";
import type { RunTurnParams } from "../src/daemon.ts";
import {
  type AgentDaemon,
  classifyEffortWithSmallModel,
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
  const approvalsDir = mkdtempSync(join(tmpdir(), "agency-daemon-approvals-"));
  dirs.push(approvalsDir);
  const daemon = await createAgentDaemon({
    workspaceRoot: "/repo/fake",
    instanceFile: tempInstanceFile(),
    adapterFor: () => textAdapter("hello from the daemon"),
    http: noopHttp,
    approvalsDir,
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

  test("providers_list honors enabled_providers from config", async () => {
    const { client } = await startFakeDaemon({
      catalog: [catalogModel("gpt-5.2", "openai"), catalogModel("claude-opus-5", "anthropic")],
      configDir: writeConfigDir({ enabled_providers: ["openai"] }),
    });

    const result = (await client.call("providers_list", {})) as {
      all: Array<{ id: string }>;
    };
    expect(result.all.map((p) => p.id)).toEqual(["openai"]);
  }, 30_000);

  test("providers_list honors per-provider whitelist", async () => {
    const { client } = await startFakeDaemon({
      catalog: [
        catalogModel("gpt-5.2", "openai"),
        catalogModel("gpt-5-mini", "openai"),
        catalogModel("claude-opus-5", "anthropic"),
      ],
      configDir: writeConfigDir({
        provider: { openai: { whitelist: ["gpt-5.2"] } },
      }),
    });

    const result = (await client.call("providers_list", {})) as {
      all: Array<{ id: string; models: Array<{ id: string }> }>;
    };
    const openai = result.all.find((p) => p.id === "openai");
    expect(openai?.models.map((m) => m.id)).toEqual(["gpt-5.2"]);
  }, 30_000);

  test("providers_list honors per-provider blacklist", async () => {
    const { client } = await startFakeDaemon({
      catalog: [catalogModel("gpt-5.2", "openai"), catalogModel("gpt-5-mini", "openai")],
      configDir: writeConfigDir({
        provider: { openai: { blacklist: ["gpt-5-mini"] } },
      }),
    });

    const result = (await client.call("providers_list", {})) as {
      all: Array<{ id: string; models: Array<{ id: string }> }>;
    };
    const openai = result.all.find((p) => p.id === "openai");
    expect(openai?.models.map((m) => m.id)).toEqual(["gpt-5.2"]);
  }, 30_000);

  test("providers_list includes apiBaseURL when catalog has it", async () => {
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
        id: "llama-4",
        family: "my-gateway",
        name: "Llama 4",
        providerName: "My Gateway",
        contextWindow: 128_000,
        maxOutputTokens: 8_000,
        pricing: { inputPerMTok: 0, outputPerMTok: 0 },
        capabilities: { tools: false, vision: false, thinking: false },
        apiBaseURL: "https://gateway.example.com/v1",
      },
    ];

    const { client } = await startFakeDaemon({ catalog });

    const result = (await client.call("providers_list", {})) as {
      all: Array<{ id: string; models: Array<{ id: string; apiBaseURL?: string }> }>;
    };
    const gateway = result.all.find((p) => p.id === "my-gateway");
    expect(gateway?.models[0]?.apiBaseURL).toBe("https://gateway.example.com/v1");
    // openai has no apiBaseURL in the catalog, so it should be undefined
    const openai = result.all.find((p) => p.id === "openai");
    expect(openai?.models[0]?.apiBaseURL).toBeUndefined();
  }, 30_000);

  // macOS has no env override for dataDir (would hit the real one), so the
  // catalog-cache sandbox only runs on Windows/Linux.
  test.skipIf(process.platform === "darwin")(
    "run_turn reads max output tokens and pricing from the model catalog, not a hardcoded default",
    async () => {
      const sandboxData = mkdtempSync(join(tmpdir(), "agency-daemon-data-"));
      dirs.push(sandboxData);
      const agencyCache = process.platform === "win32" ? join("Agency", "cache") : join("agency", "cache");
      const cacheDirPath = join(sandboxData, agencyCache);
      mkdirSync(cacheDirPath, { recursive: true });
      writeFileSync(
        join(cacheDirPath, "model-catalog.json"),
        JSON.stringify({
          savedAt: new Date().toISOString(),
          models: [
            {
              id: "catalog-model",
              family: "anthropic",
              contextWindow: 200_000,
              maxOutputTokens: 12_345,
              pricing: { inputPerMTok: 3, outputPerMTok: 15 },
              capabilities: { tools: true, vision: true, thinking: true },
            },
          ],
        }),
      );

      const captured: { maxTokens?: number } = {};
      const capturingAdapter: ProviderAdapter = {
        family: "fake",
        async *stream(request) {
          captured.maxTokens = request.maxTokens;
          yield { type: "text_delta", text: "ok" };
          yield {
            type: "message_stop",
            stopReason: "end_turn",
            usage: { inputTokens: 1_000, outputTokens: 100 },
          };
        },
      };

      const dataEnvKey = process.platform === "win32" ? "LOCALAPPDATA" : "XDG_DATA_HOME";
      const previous = process.env[dataEnvKey];
      process.env[dataEnvKey] = sandboxData;
      try {
        const { client } = await startFakeDaemon({ adapterFor: () => capturingAdapter });
        const result = (await client.call("run_turn", {
          turnId: "t-catalog",
          provider: "anthropic",
          model: "catalog-model",
          apiKey: "key",
          systemPrompt: "sys",
          session: [],
        })) as RunTurnRpcResult;

        expect(captured.maxTokens).toBe(12_345);
        expect(result.usage).toEqual({ inputTokens: 1_000, outputTokens: 100, cachedInputTokens: 0 });
      } finally {
        if (previous === undefined) delete process.env[dataEnvKey];
        else process.env[dataEnvKey] = previous;
      }
    },
  );
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

  test("the shared default carries safety, conventions, tool-use, and shell doctrine", () => {
    for (const phrase of ["Safety first", "Coding conventions", "Tool-use doctrine", "Shell dialect"]) {
      expect(DEFAULT_SYSTEM_PROMPT).toContain(phrase);
    }
  });

  test("shellLabel renders into the environment block so the model uses the right dialect", () => {
    const system = resolveSystemPrompt(params(), {
      workspaceRoot: "/repo/fake",
      git: () => null,
      shellLabel: "PowerShell",
    });
    expect(system).toContain("shell: PowerShell");
  });

  test("no shellLabel means no shell line", () => {
    const system = resolveSystemPrompt(params(), {
      workspaceRoot: "/repo/fake",
      git: () => null,
    });
    expect(system).not.toContain("shell:");
  });

  test("context=false drops the environment block and warns about lost orientation", () => {
    const warnings: unknown[][] = [];
    const orig = console.warn;
    console.warn = (...args: unknown[]) => {
      warnings.push(args);
    };
    try {
      const system = resolveSystemPrompt(params({ systemPromptParts: { context: false } }), {
        workspaceRoot: "/repo/fake",
        git: () => null,
      });
      expect(system).not.toContain("<environment>");
      expect(system).toContain("sys");
    } finally {
      console.warn = orig;
    }
    expect(warnings.join(" ")).toContain("context=false");
  });
});

describe("session RPC", () => {
  async function seedSession(sessionsDir: string, sessionId: string): Promise<void> {
    const store = new SessionStore(sessionsDir);
    store.create(sessionId);
    await store.append(sessionId, {
      type: "message",
      parentId: null,
      message: { role: "user", content: [{ type: "text", text: "hello" }] },
    });
  }

  function tempSessionsDir(): string {
    const dir = mkdtempSync(join(tmpdir(), "agency-daemon-sessions-"));
    dirs.push(dir);
    return dir;
  }

  test("session_show returns entries, the tip, and the branch messages", async () => {
    const sessionsDir = tempSessionsDir();
    await seedSession(sessionsDir, "s1");
    const { client } = await startFakeDaemon({ sessionsDir });

    const shown = (await client.call("session_show", { sessionId: "s1" })) as {
      sessionId: string;
      entries: unknown[];
      tipId: string;
      messages: unknown[];
    };
    expect(shown.sessionId).toBe("s1");
    expect(shown.entries).toHaveLength(1);
    expect(typeof shown.tipId).toBe("string");
    expect(shown.messages).toHaveLength(1);
  });

  test("session_fork starts a new branch tip in the same file", async () => {
    const sessionsDir = tempSessionsDir();
    await seedSession(sessionsDir, "s1");
    const { client } = await startFakeDaemon({ sessionsDir });

    const forked = (await client.call("session_fork", { sessionId: "s1", label: "spike" })) as {
      forked: boolean;
      sessionId: string;
      tipId: string;
    };
    expect(forked.forked).toBe(true);
    expect(forked.sessionId).toBe("s1");
    const entries = new SessionStore(sessionsDir).load("s1");
    expect(entries).toHaveLength(2);
    expect(entries[entries.length - 1]?.type).toBe("branch_summary");
  });

  test("session_clone copies the session under a new id", async () => {
    const sessionsDir = tempSessionsDir();
    await seedSession(sessionsDir, "s1");
    const { client } = await startFakeDaemon({ sessionsDir });

    const cloned = (await client.call("session_clone", { sessionId: "s1" })) as {
      cloned: boolean;
      sessionId: string;
    };
    expect(cloned.cloned).toBe(true);
    expect(cloned.sessionId).not.toBe("s1");
    expect(new SessionStore(sessionsDir).load(cloned.sessionId)).toHaveLength(1);
  });

  test("session RPC rejects missing and unknown sessions", async () => {
    const { client } = await startFakeDaemon({ sessionsDir: tempSessionsDir() });

    for (const [method, args] of [
      ["session_show", {}],
      ["session_fork", {}],
      ["session_clone", {}],
      ["session_show", { sessionId: "nope" }],
      ["session_fork", { sessionId: "nope" }],
      ["session_clone", { sessionId: "nope" }],
    ] as const) {
      let message = "";
      try {
        await client.call(method, args);
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
      expect(message.length).toBeGreaterThan(0);
    }
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

describe("dispatch cost forecast wiring", () => {
  function forecastAdapter(dispatchInput: Record<string, unknown>): ProviderAdapter {
    let call = 0;
    return {
      family: "fake",
      async *stream(): AsyncIterable<StreamEvent> {
        call += 1;
        if (call === 1) {
          yield { type: "tool_call_start", id: "c1", name: "dispatch" };
          yield { type: "tool_call_delta", id: "c1", inputJsonDelta: JSON.stringify(dispatchInput) };
          yield { type: "tool_call_end", id: "c1" };
          yield { type: "message_stop", stopReason: "tool_use", usage: { inputTokens: 1, outputTokens: 1 } };
        } else {
          yield { type: "text_delta", text: "done" };
          yield { type: "message_stop", stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1 } };
        }
      },
    };
  }

  const dispatchAgents = {
    agents: {
      leader: {
        role: "GeneralDispatcher",
        provider: "anthropic",
        model: "claude-sonnet-5",
        effort: "low",
        enabled: true,
      },
      worker: { role: "Worker", provider: "openai", model: "gpt-5.2", effort: "low", enabled: true },
    },
  };

  test("dispatch with forecastCostUsd below threshold proceeds without asking", async () => {
    const { client } = await startFakeDaemon({
      adapterFor: () => forecastAdapter({ agents: [{ handle: "worker", brief: "x" }] }),
      configDir: writeConfigDir({
        ...dispatchAgents,
        sandbox: { forecastCostUsd: 100 },
      }),
    });

    const result = (await client.call("run_turn", {
      turnId: "fc-happy",
      provider: "anthropic",
      model: "m",
      apiKey: "key",
      systemPrompt: "sys",
      session: [],
    })) as RunTurnRpcResult;

    // The forecast check passes (under threshold), so the dispatch proceeds
    // (but may fail on sub-agent spawn — that's not the forecast check's job)
    const toolResult = result.messages[1]?.content[0];
    expect(toolResult).toBeDefined();
  });

  test("dispatch with forecastCostUsd over threshold and approval rejected returns error", async () => {
    const { client } = await startFakeDaemon({
      adapterFor: () =>
        forecastAdapter({
          agents: [
            {
              handle: "worker",
              brief:
                "do a very very expensive thing that is super long to push the cost estimate over the tiny threshold",
            },
          ],
        }),
      configDir: writeConfigDir({
        ...dispatchAgents,
        sandbox: { forecastCostUsd: 0.0001 },
      }),
    });

    // Listen for the approval request and reject it
    const events: Array<{ type: string; requestId?: string }> = [];
    client.on("turn.fc-reject", (payload) => events.push(payload as { type: string }));
    const runPromise = client.call("run_turn", {
      turnId: "fc-reject",
      provider: "anthropic",
      model: "m",
      apiKey: "key",
      systemPrompt: "sys",
      session: [],
    }) as Promise<RunTurnRpcResult>;

    await new Promise((r) => setTimeout(r, 200));
    const ask = events.find((e) => e.type === "approval_requested");
    expect(ask?.requestId).toBeTruthy();
    await client.call("approval_respond", { requestId: ask?.requestId, decision: "reject" });

    const result = await runPromise;
    const toolResult = result.messages[1]?.content[0];
    expect(toolResult).toBeDefined();
    if (toolResult?.type === "tool_result") {
      expect(toolResult.isError).toBe(true);
      expect(toolResult.content).toContain("threshold");
    }
  });

  test("dispatch without forecastCostUsd configured does not check forecast", async () => {
    const { client } = await startFakeDaemon({
      adapterFor: () => forecastAdapter({ agents: [{ handle: "worker", brief: "do work" }] }),
      configDir: writeConfigDir(dispatchAgents),
    });

    const result = (await client.call("run_turn", {
      turnId: "fc-no-cfg",
      provider: "anthropic",
      model: "m",
      apiKey: "key",
      systemPrompt: "sys",
      session: [],
    })) as RunTurnRpcResult;

    // No forecast check, dispatch proceeds (but may fail on sub-agent spawn)
    const toolResult = result.messages[1]?.content[0];
    expect(toolResult).toBeDefined();
  });
});

describe("undo/redo RPC", () => {
  test("undo with nothing to undo returns undone: false", async () => {
    const { client } = await startFakeDaemon();
    const result = (await client.call("undo", {})) as { undone: boolean; path?: string };
    expect(result).toEqual({ undone: false });
  });

  test("redo with nothing to redo returns undone: false", async () => {
    const { client } = await startFakeDaemon();
    const result = (await client.call("redo", {})) as { undone: boolean; path?: string };
    expect(result).toEqual({ undone: false });
  });

  test("undo with a non-existent sessionId returns undone: false", async () => {
    const { client } = await startFakeDaemon();
    const result = (await client.call("undo", { sessionId: "no-such-session" })) as {
      undone: boolean;
      path?: string;
    };
    expect(result).toEqual({ undone: false });
  });

  test("redo with a non-existent sessionId returns undone: false", async () => {
    const { client } = await startFakeDaemon();
    const result = (await client.call("redo", { sessionId: "no-such-session" })) as {
      undone: boolean;
      path?: string;
    };
    expect(result).toEqual({ undone: false });
  });

  test("undo/redo round-trip returns the expected shape over RPC", async () => {
    const { client } = await startFakeDaemon();
    // No session scope exists yet — both return undone: false
    expect(await client.call("undo", {})).toEqual({ undone: false });
    expect(await client.call("redo", {})).toEqual({ undone: false });
  });
});

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

// --- A5: permissions, approvals, capabilities, plans, trust ---

function toolCallingAdapter(toolName: string, input: Record<string, unknown>): ProviderAdapter {
  let call = 0;
  return {
    family: "fake",
    async *stream(): AsyncIterable<StreamEvent> {
      call += 1;
      if (call === 1) {
        yield { type: "tool_call_start", id: "c1", name: toolName };
        yield { type: "tool_call_delta", id: "c1", inputJsonDelta: JSON.stringify(input) };
        yield { type: "tool_call_end", id: "c1" };
        yield { type: "message_stop", stopReason: "tool_use", usage: { inputTokens: 1, outputTokens: 1 } };
      } else {
        yield { type: "text_delta", text: "done" };
        yield { type: "message_stop", stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1 } };
      }
    },
  };
}

function capturingToolsAdapter(
  toolName: string,
  input: Record<string, unknown>,
  seenTools: Array<Array<{ name: string }>>,
): ProviderAdapter {
  let call = 0;
  return {
    family: "fake",
    async *stream(request) {
      seenTools.push((request.tools ?? []).map((t) => ({ name: t.name })));
      call += 1;
      if (call === 1) {
        yield { type: "tool_call_start", id: "c1", name: toolName };
        yield { type: "tool_call_delta", id: "c1", inputJsonDelta: JSON.stringify(input) };
        yield { type: "tool_call_end", id: "c1" };
        yield { type: "message_stop", stopReason: "tool_use", usage: { inputTokens: 1, outputTokens: 1 } };
      } else {
        yield { type: "message_stop", stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1 } };
      }
    },
  };
}

const dangerousTool: ToolSpec = {
  name: "fakebash",
  description: "fake dangerous tool",
  inputSchema: { type: "object", properties: { command: { type: "string" } } },
  riskTier: "dangerous",
  handler: async (input) => ({ content: `ran ${String((input as { command?: string }).command)}` }),
};

describe("A5 permissions and sandbox", () => {
  test("a narrowed per-turn capability set denies a tool the daemon could otherwise run", async () => {
    const { client } = await startFakeDaemon({
      adapterFor: () => toolCallingAdapter("fakebash", { command: "rm -rf build" }),
      tools: [dangerousTool],
    });

    const result = (await client.call("run_turn", {
      turnId: "caps-1",
      provider: "anthropic",
      model: "m",
      apiKey: "key",
      systemPrompt: "sys",
      session: [],
      capabilities: { tools: ["other-tool"], pathScopes: "*", network: "*" },
    })) as RunTurnRpcResult;

    const toolResult = result.messages[1]?.content[0];
    expect(toolResult).toMatchObject({ type: "tool_result", isError: true });
    if (toolResult?.type === "tool_result") {
      expect(toolResult.content).toContain("allowed tools");
    }
  });

  test("a bare deny in the permissions config filters the tool from the request entirely", async () => {
    const seenTools: Array<Array<{ name: string }>> = [];
    const { client } = await startFakeDaemon({
      adapterFor: () => capturingToolsAdapter("fakebash", { command: "x" }, seenTools),
      tools: [dangerousTool],
      configDir: writeConfigDir({ permissions: { fakebash: "deny" } }),
    });

    const result = (await client.call("run_turn", {
      turnId: "deny-1",
      provider: "anthropic",
      model: "m",
      apiKey: "key",
      systemPrompt: "sys",
      session: [],
    })) as RunTurnRpcResult;

    expect(seenTools[0]?.map((t) => t.name)).not.toContain("fakebash");
    const toolResult = result.messages[1]?.content[0];
    if (toolResult?.type === "tool_result") {
      expect(toolResult.isError).toBe(true);
      // A filtered tool was never offered: the model's call to it is refused
      // as unknown, not run and not merely policy-rejected after the fact.
      expect(toolResult.content).toContain("no such tool");
    }
  });

  test("a deny pattern in a permissions map blocks the command with a clean error", async () => {
    const { client } = await startFakeDaemon({
      adapterFor: () => toolCallingAdapter("bash", { command: "rm -rf build" }),
      tools: [
        {
          ...dangerousTool,
          name: "bash",
          handler: async (input) => ({
            content: `SHOULD NOT RUN ${String((input as { command?: string }).command)}`,
          }),
        },
      ],
      configDir: writeConfigDir({
        permissions: { bash: { "*": "allow", "rm *": "deny" } },
      }),
    });

    const result = (await client.call("run_turn", {
      turnId: "deny-2",
      provider: "anthropic",
      model: "m",
      apiKey: "key",
      systemPrompt: "sys",
      session: [],
    })) as RunTurnRpcResult;

    const toolResult = result.messages[1]?.content[0];
    expect(toolResult).toMatchObject({ type: "tool_result", isError: true });
    if (toolResult?.type === "tool_result") {
      expect(toolResult.content).toContain("permission denied");
      expect(toolResult.content).not.toContain("SHOULD NOT RUN");
    }
  });

  test("an unconfigured dangerous tool asks; once runs it, and always persists for the session", async () => {
    const { client } = await startFakeDaemon({
      adapterFor: () => toolCallingAdapter("fakebash", { command: "rm -rf build" }),
      tools: [dangerousTool],
    });

    // Turn 1: an approval request is broadcast; answering once runs the tool.
    const events1: Array<{ type: string; requestId?: string }> = [];
    client.on("turn.ask-1", (payload) => events1.push(payload as { type: string }));
    const run1 = client.call("run_turn", {
      turnId: "ask-1",
      provider: "anthropic",
      model: "m",
      apiKey: "key",
      systemPrompt: "sys",
      session: [],
    });
    await new Promise((r) => setTimeout(r, 100));
    const ask = events1.find((e) => e.type === "approval_requested");
    expect(ask?.requestId).toBeTruthy();
    const responded = await client.call("approval_respond", {
      requestId: ask?.requestId,
      decision: "once",
    });
    expect(responded).toMatchObject({ resolved: true });
    const result1 = (await run1) as RunTurnRpcResult;
    const toolResult1 = result1.messages[1]?.content[0];
    if (toolResult1?.type === "tool_result") {
      expect(toolResult1.isError).toBe(false);
      expect(toolResult1.content).toContain("ran rm -rf build");
    }

    // Turn 2: still asks (once granted nothing durable).
    const events2: Array<{ type: string; requestId?: string }> = [];
    client.on("turn.ask-2", (payload) => events2.push(payload as { type: string }));
    const run2 = client.call("run_turn", {
      turnId: "ask-2",
      provider: "anthropic",
      model: "m",
      apiKey: "key",
      systemPrompt: "sys",
      session: [],
    });
    await new Promise((r) => setTimeout(r, 100));
    const ask2 = events2.find((e) => e.type === "approval_requested");
    expect(ask2?.requestId).toBeTruthy();
    await client.call("approval_respond", { requestId: ask2?.requestId, decision: "always" });
    await run2;

    // Turn 3: the session-scoped "always" grant answers without a new ask.
    const events3: Array<{ type: string }> = [];
    client.on("turn.ask-3", (payload) => events3.push(payload as { type: string }));
    await client.call("run_turn", {
      turnId: "ask-3",
      provider: "anthropic",
      model: "m",
      apiKey: "key",
      systemPrompt: "sys",
      session: [],
    });
    await new Promise((r) => setTimeout(r, 100));
    expect(events3.find((e) => e.type === "approval_requested")).toBeUndefined();
  }, 30_000);

  test("an untrusted workspace denies mutating tools when trust is required, safe tools still run", async () => {
    const trustStorePath = join(tempInstanceFile(), "..", "trust.json");
    const { client } = await startFakeDaemon({
      adapterFor: () => toolCallingAdapter("fakebash", { command: "anything" }),
      tools: [dangerousTool],
      trustStorePath,
      configDir: writeConfigDir({ trust: { required: true } }),
    });

    const result = (await client.call("run_turn", {
      turnId: "trust-1",
      provider: "anthropic",
      model: "m",
      apiKey: "key",
      systemPrompt: "sys",
      session: [],
    })) as RunTurnRpcResult;

    const toolResult = result.messages[1]?.content[0];
    expect(toolResult).toMatchObject({ type: "tool_result", isError: true });
    if (toolResult?.type === "tool_result") {
      expect(toolResult.content).toContain("permission denied");
    }
  });

  test("plan_approve writes the approval record and refuses plans with unresolved comments", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "agency-daemon-plan-"));
    dirs.push(workspace);
    mkdirSync(join(workspace, ".agency", "plans"), { recursive: true });
    const planPath = join(workspace, ".agency", "plans", "my-plan.md");
    writeFileSync(planPath, "# plan\n\n- [ ] step one\n");

    const { client } = await startFakeDaemon({ workspaceRoot: workspace });

    const noApproval = await client.call("plan_approve", { path: planPath });
    expect(noApproval).toMatchObject({ record: { approvedBy: "user" } });
    expect(readFileSync(`${planPath}.approval.json`, "utf8")).toContain('"hash"');

    // Unresolved comments block approval.
    writeFileSync(
      `${planPath}.comments.json`,
      JSON.stringify({ comments: [{ text: "step 1 is wrong", resolved: false }] }),
    );
    let rejection: string | undefined;
    try {
      await client.call("plan_approve", { path: planPath });
    } catch (error) {
      rejection = error instanceof Error ? error.message : String(error);
    }
    expect(rejection).toContain("unresolved comment");
  });

  test("plan_approve refuses paths outside the workspace", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "agency-daemon-plan2-"));
    dirs.push(workspace);
    const { client } = await startFakeDaemon({ workspaceRoot: workspace });

    let rejection: string | undefined;
    try {
      await client.call("plan_approve", { path: "/definitely/outside/plan.md" });
    } catch (error) {
      rejection = error instanceof Error ? error.message : String(error);
    }
    expect(rejection).toContain("outside the sandbox root");
  });
});

describe("HTTP+SSE gateway mounted alongside TCP", () => {
  test("POST /rpc succeeds with bearer token, GET /health without token, 401 without token", async () => {
    const daemon = await createAgentDaemon({
      workspaceRoot: "/repo/fake",
      instanceFile: tempInstanceFile(),
      adapterFor: () => textAdapter("hello from the daemon"),
      http: noopHttp,
      tools: [],
    });
    daemons.push(daemon);

    const httpBase = `http://127.0.0.1:${daemon.httpPort}`;
    const token = daemon.server.token!;

    // POST /rpc with correct token succeeds
    const rpcRes = await fetch(`${httpBase}/rpc`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ id: "test-1", method: "providers_list" }),
    });
    expect(rpcRes.status).toBe(200);
    const rpcBody = (await rpcRes.json()) as { id: string; result: unknown };
    expect(rpcBody.id).toBe("test-1");
    expect(rpcBody.result).toBeDefined();

    // GET /health without token succeeds (health is unauthenticated)
    const healthRes = await fetch(`${httpBase}/health`);
    expect(healthRes.status).toBe(200);
    const healthBody = (await healthRes.json()) as { ok: boolean };
    expect(healthBody.ok).toBe(true);

    // POST /rpc without token is rejected
    const noAuthRes = await fetch(`${httpBase}/rpc`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "test-2", method: "providers_list" }),
    });
    expect(noAuthRes.status).toBe(401);

    // GET /events without token is rejected
    const eventsNoAuth = await fetch(`${httpBase}/events?stream=turn.abc`);
    expect(eventsNoAuth.status).toBe(401);

    // GET /events with token succeeds and receives SSE
    const eventsRes = await fetch(`${httpBase}/events?stream=turn.abc`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(eventsRes.status).toBe(200);
    expect(eventsRes.headers.get("Content-Type")).toContain("text/event-stream");
    await eventsRes.body!.cancel();
  });

  test("SSE events broadcast through the HTTP gateway reach subscribers", async () => {
    const daemon = await createAgentDaemon({
      workspaceRoot: "/repo/fake",
      instanceFile: tempInstanceFile(),
      adapterFor: () => textAdapter("hello from the daemon"),
      http: noopHttp,
      tools: [],
    });
    daemons.push(daemon);

    const httpBase = `http://127.0.0.1:${daemon.httpPort}`;
    const token = daemon.server.token!;

    // Subscribe to SSE events
    const eventsRes = await fetch(`${httpBase}/events?stream=turn.test-sse`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(eventsRes.status).toBe(200);

    // Run a turn — it should broadcast events over the HTTP gateway
    const client = await connectToDaemon(daemon.server.port, "127.0.0.1", { token });
    clients.push(client);

    await client.call("run_turn", {
      turnId: "test-sse",
      provider: "anthropic",
      model: "test-model",
      apiKey: "key",
      systemPrompt: "sys",
      session: [],
    });

    // Collect SSE data
    const reader = eventsRes.body!.getReader();
    const decoder = new TextDecoder();
    let acc = "";
    const deadline = Date.now() + 3_000;
    while (Date.now() < deadline && !acc.includes("event: turn.test-sse")) {
      const { done, value } = await reader.read();
      if (done) break;
      acc += decoder.decode(value, { stream: true });
    }
    await reader.cancel().catch(() => {});

    expect(acc).toContain("event: turn.test-sse");
    expect(acc).toContain("text_delta");
  });
});

describe("classifyEffortWithSmallModel", () => {
  const noopHttp: HttpClient = { fetch: async () => new Response() };
  const noopAdapter: ProviderAdapter = {
    family: "fake",
    async *stream() {
      yield { type: "text_delta", text: "low" };
      yield { type: "message_stop", stopReason: "end_turn", usage: { inputTokens: 3, outputTokens: 2 } };
    },
  };

  test("falls back to keyword heuristic when small_model is absent from config", async () => {
    const result = await classifyEffortWithSmallModel("fix a typo in the readme", {
      config: {},
      adapterFor: () => noopAdapter,
      http: noopHttp,
      apiKey: "key",
      providers: {},
    });
    // "fix a typo in the readme" is short (< 20 chars) → classifyEffortFromText returns "low"
    expect(result).toBe("low");
  });

  test("falls back to keyword heuristic when adapter resolution fails", async () => {
    const result = await classifyEffortWithSmallModel("complex architecture redesign", {
      config: { small_model: "anthropic/claude-sonnet-5" },
      adapterFor: () => {
        throw new Error("unknown provider");
      },
      http: noopHttp,
      apiKey: "key",
      providers: {},
    });
    // "complex architecture redesign" contains "architecture" → classifyEffortFromText returns "high"
    expect(result).toBe("high");
  });

  test("traces as effort-classification span when traceRecorder is provided", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agency-effort-trace-"));
    dirs.push(dir);
    const recorder = new TraceRecorder({
      sessionsDir: dir,
      sessionId: "test-session",
      traceId: "test-trace",
    });

    const result = await classifyEffortWithSmallModel("review the authentication flow", {
      config: { small_model: "anthropic/claude-sonnet-5" },
      adapterFor: () => noopAdapter,
      http: noopHttp,
      apiKey: "key",
      providers: {},
      traceRecorder: recorder,
    });

    expect(result).toBe("low");
    const spans = recorder.getSpans();
    expect(spans.length).toBe(1);
    expect(spans[0]!.name).toBe("effort-classification");
    expect(spans[0]!.kind).toBe("tool");
    expect(spans[0]!.status).toBe("ok");
    expect(spans[0]!.attributes.model).toBe("claude-sonnet-5");
    expect(spans[0]!.attributes.provider).toBe("anthropic");
    expect(spans[0]!.attributes.effort).toBe("low");
  });

  test("traces error status when small_model call fails", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agency-effort-error-"));
    dirs.push(dir);
    const recorder = new TraceRecorder({
      sessionsDir: dir,
      sessionId: "test-session",
      traceId: "test-trace",
    });

    const result = await classifyEffortWithSmallModel("complex architecture redesign", {
      config: { small_model: "anthropic/claude-sonnet-5" },
      adapterFor: () => ({
        family: "fake",
        // biome-ignore lint/correctness/useYield: mock that intentionally throws
        async *stream() {
          throw new Error("API error");
        },
      }),
      http: noopHttp,
      apiKey: "key",
      providers: {},
      traceRecorder: recorder,
    });

    // Falls back to keyword heuristic
    expect(result).toBe("high");
    const spans = recorder.getSpans();
    expect(spans.length).toBe(1);
    expect(spans[0]!.name).toBe("effort-classification");
    expect(spans[0]!.status).toBe("error");
  });
});
