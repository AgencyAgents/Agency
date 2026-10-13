import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore, type ToolSpec, TraceRecorder } from "@agency/core";
import { createFileTrustStore } from "@agency/guard";
import type { HttpClient } from "@agency/net";
import type { ModelInfo, ProviderAdapter, StreamEvent } from "@agency/providers";
import { connectToDaemon, type DaemonClient } from "@agency/rpc";
import { AgencyError, ErrorCode } from "@agency/schema";
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

function tempRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "agency-daemon-root-"));
  dirs.push(dir);
  return dir;
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
  const workspaceRoot = tempRoot();
  const daemon = await createAgentDaemon({
    workspaceRoot,
    instanceFile: tempInstanceFile(),
    adapterFor: () => textAdapter("hello from the daemon"),
    http: noopHttp,
    approvalsDir,
    ...overrides,
  });
  daemons.push(daemon);
  const client = await connectToDaemon(daemon.server.port, "127.0.0.1", { token: daemon.server.token });
  clients.push(client);
  return { daemon, client, workspaceRoot };
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
      // Explicit tier: a missing tier fails safe to ask, which would park
      // this turn at the approval gate instead of running the tool.
      riskTier: "safe",
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

  test("cancel_turn settles a run_turn parked at the approval gate", async () => {
    const { client } = await startFakeDaemon({
      adapterFor: () => toolCallingAdapter("fakebash", { command: "rm -rf build" }),
      tools: [dangerousTool],
    });

    const events: Array<{ type: string; requestId?: string }> = [];
    client.on("turn.ask-cancel", (payload) => events.push(payload as { type: string }));
    const runPromise = client.call("run_turn", {
      turnId: "ask-cancel",
      provider: "anthropic",
      model: "m",
      apiKey: "key",
      systemPrompt: "sys",
      session: [],
    });

    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      if (events.some((e) => e.type === "approval_requested")) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(events.some((e) => e.type === "approval_requested")).toBe(true);

    const cancelResult = await client.call("cancel_turn", { turnId: "ask-cancel" });
    expect(cancelResult).toEqual({ cancelled: true });
    const result = (await runPromise) as RunTurnRpcResult;
    expect(result.cancelled).toBe(true);
  }, 30_000);

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

  test("a fallback model on a provider with no key is not used: the primary key stays with its provider", async () => {
    const seen: Array<{ provider: string; apiKey: string }> = [];
    const adapterFor = (provider: string): ProviderAdapter => ({
      family: "fake",
      // biome-ignore lint/correctness/useYield: the stand-in fails before it streams anything.
      async *stream(request): AsyncIterable<StreamEvent> {
        seen.push({ provider, apiKey: request.apiKey });
        throw new AgencyError(ErrorCode.OVERLOAD, "overloaded", { source: "fake" });
      },
    });
    const saved = { a: process.env.AGENCY_OPENAI_API_KEY, b: process.env.OPENAI_API_KEY };
    delete process.env.AGENCY_OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    try {
      const { client } = await startFakeDaemon({
        adapterFor,
        configDir: writeConfigDir({ fallback_model: "openai/gpt-x" }),
      });
      let rejection: string | undefined;
      try {
        await client.call("run_turn", {
          turnId: "t-fallback-keyless",
          provider: "anthropic",
          model: "test-model",
          apiKey: "primary-key",
          systemPrompt: "sys",
          session: [],
        });
      } catch (error) {
        rejection = error instanceof Error ? error.message : String(error);
      }

      expect(rejection).toMatch(/overloaded/);
      expect(seen.filter((call) => call.provider !== "anthropic")).toEqual([]);
    } finally {
      if (saved.a !== undefined) process.env.AGENCY_OPENAI_API_KEY = saved.a;
      if (saved.b !== undefined) process.env.OPENAI_API_KEY = saved.b;
    }
  }, 60_000);

  test("a turn reads its key from a variable name that the provider config declares", async () => {
    const seen: string[] = [];
    const adapterFor = (): ProviderAdapter => ({
      family: "fake",
      async *stream(request): AsyncIterable<StreamEvent> {
        seen.push(request.apiKey);
        yield { type: "text_delta", text: "ok" };
        yield { type: "message_stop", stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1 } };
      },
    });
    const saved = process.env.MY_GATEWAY_KEY;
    process.env.MY_GATEWAY_KEY = "declared-key";
    try {
      const { client } = await startFakeDaemon({
        adapterFor,
        configDir: writeConfigDir({
          provider: { "my-gateway": { baseUrl: "http://gateway.test/v1", env: ["MY_GATEWAY_KEY"] } },
        }),
      });
      await client.call("run_turn", {
        turnId: "t-declared-env",
        provider: "my-gateway",
        model: "m",
        systemPrompt: "sys",
        session: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      });
      expect(seen).toEqual(["declared-key"]);
    } finally {
      if (saved === undefined) delete process.env.MY_GATEWAY_KEY;
      else process.env.MY_GATEWAY_KEY = saved;
    }
  }, 60_000);

  test("a fallback request uses the fallback model's own output limit", async () => {
    const limits: Record<string, number> = {};
    const adapterFor = (provider: string): ProviderAdapter => ({
      family: "fake",
      async *stream(request): AsyncIterable<StreamEvent> {
        limits[provider] = request.maxTokens;
        if (provider === "anthropic")
          throw new AgencyError(ErrorCode.OVERLOAD, "overloaded", { source: "fake" });
        yield { type: "text_delta", text: "from the fallback" };
        yield { type: "message_stop", stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1 } };
      },
    });
    const saved = process.env.AGENCY_OPENAI_API_KEY;
    process.env.AGENCY_OPENAI_API_KEY = "fallback-key";
    try {
      const { client } = await startFakeDaemon({
        adapterFor,
        configDir: writeConfigDir({
          fallback_model: "openai/gpt-x",
          provider: {
            anthropic: { models: { "test-model": { contextWindow: 9000, maxOutputTokens: 900 } } },
            openai: { models: { "gpt-x": { contextWindow: 5000, maxOutputTokens: 123 } } },
          },
        }),
      });
      await client.call("run_turn", {
        turnId: "t-fallback-limit",
        provider: "anthropic",
        model: "test-model",
        apiKey: "primary-key",
        systemPrompt: "sys",
        session: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      });

      expect(limits).toEqual({ anthropic: 900, openai: 123 });
    } finally {
      if (saved === undefined) delete process.env.AGENCY_OPENAI_API_KEY;
      else process.env.AGENCY_OPENAI_API_KEY = saved;
    }
  }, 60_000);

  test("a turn that ran on the fallback is priced as the fallback model", async () => {
    const adapterFor = (provider: string): ProviderAdapter => ({
      family: "fake",
      async *stream(): AsyncIterable<StreamEvent> {
        if (provider === "anthropic")
          throw new AgencyError(ErrorCode.OVERLOAD, "overloaded", { source: "fake" });
        yield { type: "text_delta", text: "from the fallback" };
        yield {
          type: "message_stop",
          stopReason: "end_turn",
          usage: { inputTokens: 1_000_000, outputTokens: 0 },
        };
      },
    });
    const saved = process.env.AGENCY_OPENAI_API_KEY;
    process.env.AGENCY_OPENAI_API_KEY = "fallback-key";
    try {
      const { client } = await startFakeDaemon({
        adapterFor,
        configDir: writeConfigDir({
          fallback_model: "openai/gpt-x",
          provider: {
            anthropic: {
              apiKey: "primary-key",
              models: { "test-model": { pricing: { inputPerMTok: 100, outputPerMTok: 100 } } },
            },
            openai: { models: { "gpt-x": { pricing: { inputPerMTok: 1, outputPerMTok: 1 } } } },
          },
        }),
      });
      const meters: Array<{ type: string; turnCostUsd?: number }> = [];
      client.on("turn.t-fallback-cost", (payload) => meters.push(payload as { type: string }));
      await client.call("run_turn", {
        turnId: "t-fallback-cost",
        provider: "anthropic",
        model: "test-model",
        apiKey: "primary-key",
        systemPrompt: "sys",
        session: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      });

      expect(meters.find((event) => event.type === "cost_meter")?.turnCostUsd).toBe(1);

      const sent = (await client.call("session_send", {
        sessionId: "s-fallback-cost",
        provider: "anthropic",
        model: "test-model",
        systemPrompt: "sys",
        userText: "hi",
      })) as { servedBy?: unknown };
      expect(sent.servedBy).toEqual({ provider: "openai", model: "gpt-x" });
      const report = (await client.call("cost_report", { sessionId: "s-fallback-cost" })) as {
        sessions: Array<{ costUsd: number }>;
      };
      expect(report.sessions[0]?.costUsd).toBe(1);
    } finally {
      if (saved === undefined) delete process.env.AGENCY_OPENAI_API_KEY;
      else process.env.AGENCY_OPENAI_API_KEY = saved;
    }
  }, 60_000);

  test("the model's vision capability reaches the provider request", async () => {
    const seen: Array<boolean | undefined> = [];
    const adapter: ProviderAdapter = {
      family: "fake",
      async *stream(request): AsyncIterable<StreamEvent> {
        seen.push(request.vision);
        yield { type: "text_delta", text: "ok" };
        yield { type: "message_stop", stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1 } };
      },
    };
    const { client } = await startFakeDaemon({
      adapterFor: () => adapter,
      configDir: writeConfigDir({
        provider: { anthropic: { models: { "sees-images": { capabilities: { vision: true } } } } },
      }),
    });
    for (const model of ["sees-images", "not-in-the-catalog"]) {
      await client.call("run_turn", {
        turnId: `t-vision-${model}`,
        provider: "anthropic",
        model,
        apiKey: "key",
        systemPrompt: "sys",
        session: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      });
    }

    expect(seen).toEqual([true, undefined]);
  });

  test("a spawned worker gets the vision capability of its model", async () => {
    const seenByWorker: Array<boolean | undefined> = [];
    const adapter: ProviderAdapter = {
      family: "fake",
      async *stream(request): AsyncIterable<StreamEvent> {
        const worker = (request.system ?? "").includes("ephemeral worker");
        if (worker) seenByWorker.push(request.vision);
        const spawned = request.messages.some((m) => m.content.some((b) => b.type === "tool_result"));
        if (!worker && !spawned) {
          yield { type: "tool_call_start", id: "c1", name: "spawn" };
          yield { type: "tool_call_delta", id: "c1", inputJsonDelta: JSON.stringify({ prompt: "look" }) };
          yield { type: "tool_call_end", id: "c1" };
          yield { type: "message_stop", stopReason: "tool_use", usage: { inputTokens: 1, outputTokens: 1 } };
          return;
        }
        yield { type: "text_delta", text: "ok" };
        yield { type: "message_stop", stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1 } };
      },
    };
    const { client } = await startFakeDaemon({
      adapterFor: () => adapter,
      configDir: writeConfigDir({
        provider: { anthropic: { models: { "sees-images": { capabilities: { vision: true } } } } },
      }),
    });
    await client.call("run_turn", {
      turnId: "t-worker-vision",
      provider: "anthropic",
      model: "sees-images",
      apiKey: "key",
      systemPrompt: "sys",
      session: [],
      sessionId: "s-worker-vision",
    });

    expect(seenByWorker).toEqual([true]);
  }, 60_000);

  test("a context overflow that cannot be folded returns its cause, not a bare error", async () => {
    const { client } = await startFakeDaemon({
      adapterFor: () => ({
        family: "fake",
        stream(): AsyncIterable<StreamEvent> {
          throw new AgencyError(ErrorCode.CONTEXT_OVERFLOW, "prompt is too long", { source: "fake" });
        },
      }),
    });

    const result = (await client.call("run_turn", {
      turnId: "t-overflow-cause",
      provider: "anthropic",
      model: "test-model",
      apiKey: "key",
      systemPrompt: "sys",
      session: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    })) as RunTurnRpcResult;

    expect(result.stopReason).toBe("error");
    expect(result.error).toEqual({ code: "context_overflow", message: "prompt is too long" });
  });

  test("a fallback model continues the turn: tools the primary already ran do not run again", async () => {
    let runs = 0;
    const countTool: ToolSpec = {
      name: "count",
      description: "counts its own runs",
      inputSchema: {},
      riskTier: "safe",
      handler: async () => {
        runs += 1;
        return { content: `run ${runs}` };
      },
    };
    const hasResult = (request: { messages: Array<{ content: Array<{ type: string }> }> }): boolean =>
      request.messages.some((message) => message.content.some((block) => block.type === "tool_result"));
    const adapterFor = (provider: string): ProviderAdapter => ({
      family: "fake",
      async *stream(request): AsyncIterable<StreamEvent> {
        if (!hasResult(request)) {
          yield { type: "tool_call_start", id: "c1", name: "count" };
          yield { type: "tool_call_delta", id: "c1", inputJsonDelta: "{}" };
          yield { type: "tool_call_end", id: "c1" };
          yield { type: "message_stop", stopReason: "tool_use", usage: { inputTokens: 1, outputTokens: 1 } };
          return;
        }
        if (provider === "anthropic")
          throw new AgencyError(ErrorCode.OVERLOAD, "overloaded", { source: "fake" });
        yield { type: "text_delta", text: "finished on the fallback" };
        yield { type: "message_stop", stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1 } };
      },
    });
    const saved = process.env.AGENCY_OPENAI_API_KEY;
    process.env.AGENCY_OPENAI_API_KEY = "fallback-key";
    try {
      const { client } = await startFakeDaemon({
        adapterFor,
        tools: [countTool],
        configDir: writeConfigDir({ fallback_model: "openai/gpt-x" }),
      });
      const result = (await client.call("run_turn", {
        turnId: "t-fallback-continue",
        provider: "anthropic",
        model: "test-model",
        apiKey: "primary-key",
        systemPrompt: "sys",
        session: [{ role: "user", content: [{ type: "text", text: "count once" }] }],
      })) as RunTurnRpcResult;

      expect(result.stopReason).toBe("end_turn");
      expect(runs).toBe(1);
    } finally {
      if (saved === undefined) delete process.env.AGENCY_OPENAI_API_KEY;
      else process.env.AGENCY_OPENAI_API_KEY = saved;
    }
  }, 60_000);

  test("a key that a tool result holds does not reach the model or the result of the turn", async () => {
    const envKey = "env-key-value-9d2c";
    const turnKey = "turn-key-value-41aa";
    const dumpTool: ToolSpec = {
      name: "dump",
      description: "prints the keys, as an env dump does",
      inputSchema: {},
      riskTier: "safe",
      handler: async () => ({
        content: `OTHERPROV_API_KEY=${envKey}\nkey of the turn: ${turnKey}\nplain text stays`,
      }),
    };
    const requests: string[] = [];
    const adapterFor = (): ProviderAdapter => ({
      family: "fake",
      async *stream(request): AsyncIterable<StreamEvent> {
        requests.push(JSON.stringify(request.messages));
        if (requests.length === 1) {
          yield { type: "tool_call_start", id: "c1", name: "dump" };
          yield { type: "tool_call_delta", id: "c1", inputJsonDelta: "{}" };
          yield { type: "tool_call_end", id: "c1" };
          yield { type: "message_stop", stopReason: "tool_use", usage: { inputTokens: 1, outputTokens: 1 } };
          return;
        }
        yield { type: "text_delta", text: "done" };
        yield { type: "message_stop", stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1 } };
      },
    });
    process.env.OTHERPROV_API_KEY = envKey;
    try {
      const { client } = await startFakeDaemon({ adapterFor, tools: [dumpTool] });
      const result = (await client.call("run_turn", {
        turnId: "t-redact-tool-result",
        provider: "anthropic",
        model: "test-model",
        apiKey: turnKey,
        systemPrompt: "sys",
        session: [{ role: "user", content: [{ type: "text", text: "dump" }] }],
      })) as RunTurnRpcResult;

      const seen = `${requests[1]}${JSON.stringify(result.messages)}`;
      expect(seen).not.toContain(envKey);
      expect(seen).not.toContain(turnKey);
      expect(requests[1]).toContain("OTHERPROV_API_KEY=[REDACTED]");
      expect(requests[1]).toContain("plain text stays");
    } finally {
      delete process.env.OTHERPROV_API_KEY;
    }
  }, 30_000);

  test.each([
    ["moves to the fallback", ErrorCode.OVERLOAD, 101],
    ["fails", ErrorCode.AUTH, 100],
  ])(
    "the tokens of a finished step count as spend when the turn then %s",
    async (_name, code, expectedUsd) => {
      const noop: ToolSpec = {
        name: "noop",
        description: "does nothing",
        inputSchema: {},
        riskTier: "safe",
        handler: async () => ({ content: "done" }),
      };
      const usage = { inputTokens: 1_000_000, outputTokens: 0 };
      const adapterFor = (provider: string): ProviderAdapter => ({
        family: "fake",
        async *stream(request): AsyncIterable<StreamEvent> {
          const stepDone = request.messages.some((m) => m.content.some((b) => b.type === "tool_result"));
          if (!stepDone) {
            yield { type: "tool_call_start", id: "c1", name: "noop" };
            yield { type: "tool_call_delta", id: "c1", inputJsonDelta: "{}" };
            yield { type: "tool_call_end", id: "c1" };
            yield { type: "message_stop", stopReason: "tool_use", usage };
            return;
          }
          if (provider === "anthropic") throw new AgencyError(code, "no more", { source: "fake" });
          yield { type: "text_delta", text: "finished on the fallback" };
          yield { type: "message_stop", stopReason: "end_turn", usage };
        },
      });
      const saved = process.env.AGENCY_OPENAI_API_KEY;
      process.env.AGENCY_OPENAI_API_KEY = "fallback-key";
      try {
        const { client } = await startFakeDaemon({
          adapterFor,
          tools: [noop],
          configDir: writeConfigDir({
            fallback_model: "openai/gpt-x",
            provider: {
              anthropic: { models: { "test-model": { pricing: { inputPerMTok: 100, outputPerMTok: 100 } } } },
              openai: { models: { "gpt-x": { pricing: { inputPerMTok: 1, outputPerMTok: 1 } } } },
            },
          }),
        });
        const spent = async () =>
          ((await client.call("cost_report", {})) as { spend: { dayTotalUsd: number } }).spend.dayTotalUsd;
        const before = await spent();
        await client
          .call("run_turn", {
            turnId: `t-spend-${code}`,
            provider: "anthropic",
            model: "test-model",
            apiKey: "primary-key",
            systemPrompt: "sys",
            session: [{ role: "user", content: [{ type: "text", text: "go" }] }],
          })
          .catch(() => {});

        expect((await spent()) - before).toBe(expectedUsd);
      } finally {
        if (saved === undefined) delete process.env.AGENCY_OPENAI_API_KEY;
        else process.env.AGENCY_OPENAI_API_KEY = saved;
      }
    },
    60_000,
  );

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

  test("a spawned daemon that no client reaches leaves after the linger", async () => {
    const left = { spawned: false, embedded: false };
    for (const kind of ["spawned", "embedded"] as const) {
      const daemon = await createAgentDaemon({
        workspaceRoot: tempRoot(),
        instanceFile: tempInstanceFile(),
        adapterFor: () => textAdapter("unused"),
        http: noopHttp,
        idleLingerMs: 30,
        idleFromStart: kind === "spawned",
        onIdleShutdown: () => (left[kind] = true),
      });
      daemons.push(daemon);
    }
    await new Promise((r) => setTimeout(r, 200));
    // An embedded daemon (serve, the SDK) can have HTTP clients only: it stays.
    expect(left).toEqual({ spawned: true, embedded: false });
  });

  test("an idle daemon leaves when its config changes, so the next run loads the new config", async () => {
    let shutdownCalled = false;
    const { client, workspaceRoot } = await startFakeDaemon({
      idleLingerMs: 60_000,
      onIdleShutdown: () => (shutdownCalled = true),
    });

    await client.close();
    clients.length = 0;
    mkdirSync(join(workspaceRoot, ".agency"), { recursive: true });
    writeFileSync(join(workspaceRoot, ".agency", "config.jsonc"), "{}");
    await new Promise((r) => setTimeout(r, 1_500));

    expect(shutdownCalled).toBe(true);
  });

  test("an idle daemon leaves when a hook file or an MCP file of its workspace changes, and when a new one comes", async () => {
    const left: Record<string, boolean> = {};
    for (const [change, file] of [
      ["edit", "a.json"],
      ["add", "b.json"],
      ["mcp", join("..", "..", ".mcp.json")],
    ] as const) {
      const workspaceRoot = tempRoot();
      const hooksDir = join(workspaceRoot, ".agency", "hooks");
      mkdirSync(hooksDir, { recursive: true });
      writeFileSync(join(hooksDir, "a.json"), "{}");
      left[change] = false;
      const { client } = await startFakeDaemon({
        workspaceRoot,
        idleLingerMs: 60_000,
        onIdleShutdown: () => (left[change] = true),
      });
      await client.close();
      clients.length = 0;
      writeFileSync(join(hooksDir, file), '{"hooks":{}}');
      await new Promise((r) => setTimeout(r, 1_500));
    }
    expect(left).toEqual({ edit: true, add: true, mcp: true });
  }, 20_000);

  test("the MCP servers of a workspace start only in a trusted workspace", async () => {
    const failures = async (trusted: boolean): Promise<string[]> => {
      const workspaceRoot = tempRoot();
      // A server that cannot start is in the failure list: the list shows which servers the daemon tried.
      writeFileSync(
        join(workspaceRoot, ".mcp.json"),
        JSON.stringify({ mcpServers: { projectserver: { command: "agency-no-such-mcp-server" } } }),
      );
      const trustStorePath = join(tempRoot(), "trust.json");
      if (trusted) createFileTrustStore(trustStorePath).trust(workspaceRoot);
      const { client } = await startFakeDaemon({ workspaceRoot, trustStorePath, tools: undefined });
      await client.call("run_turn", {
        turnId: `mcp-${trusted}`,
        sessionId: "s1",
        provider: "anthropic",
        model: "test-model",
        apiKey: "key",
        systemPrompt: "sys",
        session: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      });
      const status = (await client.call("mcp_status", { sessionId: "s1" })) as {
        failures: Record<string, string>;
      };
      return Object.keys(status.failures);
    };
    expect(await failures(false)).toEqual([]);
    expect(await failures(true)).toEqual(["projectserver"]);
  }, 60_000);

  test("a daemon that stops does not delete the instance file of the daemon that took its place", async () => {
    const instanceFile = tempInstanceFile();
    const { daemon, client } = await startFakeDaemon({ instanceFile });
    await client.close();
    clients.length = 0;
    // The close of the client must be over before the server destroys its sockets (Bun on Windows).
    await new Promise((r) => setTimeout(r, 100));
    const successor = JSON.stringify({ port: 1, pid: 1, startedAt: "", version: 2, token: "other" });
    writeFileSync(instanceFile, successor);
    await daemon.stop();
    expect(readFileSync(instanceFile, "utf8")).toBe(successor);
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

  test("run_turn reads max output tokens and pricing from the model catalog, not a hardcoded default", async () => {
    const sandboxData = mkdtempSync(join(tmpdir(), "agency-daemon-data-"));
    dirs.push(sandboxData);
    const cacheDirPath = join(sandboxData, "data", "cache");
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

    const dataEnvKey = "AGENCY_HOME";
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
  });

  test("run_turn takes the limits of an openrouter model from the provider's model list, with one read", async () => {
    const maxTokens: Array<number | undefined> = [];
    const capturingAdapter: ProviderAdapter = {
      family: "fake",
      async *stream(request) {
        maxTokens.push(request.maxTokens);
        yield { type: "text_delta", text: "ok" };
        yield { type: "message_stop", stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1 } };
      },
    };
    const list = await Bun.file(
      join(import.meta.dir, "..", "..", "providers", "test", "cassettes", "openrouter-models.json"),
    ).text();
    const reads: string[] = [];
    const http: HttpClient = {
      fetch: async (url) => {
        reads.push(String(url));
        return new Response(list, { status: 200 });
      },
    };
    const { client } = await startFakeDaemon({ adapterFor: () => capturingAdapter, http });
    const turn = (turnId: string, model: string) =>
      client.call("run_turn", {
        turnId,
        provider: "openrouter",
        model,
        apiKey: "key",
        systemPrompt: "s",
        session: [],
      });

    await turn("t1", "deepseek/deepseek-v4-flash");
    await turn("t2", "liquid/lfm-2.5-2.6b:free");
    // A model that the list does not have keeps the default.
    await turn("t3", "no-such/model");

    expect(maxTokens).toEqual([32_000, 8192, 8192]);
    expect(reads).toEqual(["https://openrouter.ai/api/v1/models"]);
  });

  test("run_turn keeps the default limits when the model list cannot be read", async () => {
    let maxTokens: number | undefined;
    const capturingAdapter: ProviderAdapter = {
      family: "fake",
      async *stream(request) {
        maxTokens = request.maxTokens;
        yield { type: "text_delta", text: "ok" };
        yield { type: "message_stop", stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1 } };
      },
    };
    const http: HttpClient = { fetch: async () => new Response("down", { status: 503 }) };
    const { client } = await startFakeDaemon({ adapterFor: () => capturingAdapter, http });

    const result = (await client.call("run_turn", {
      turnId: "t1",
      provider: "openrouter",
      model: "deepseek/deepseek-v4-flash",
      apiKey: "key",
      systemPrompt: "s",
      session: [],
    })) as RunTurnRpcResult;

    expect(result.stopReason).toBe("end_turn");
    expect(maxTokens).toBe(8192);
  });
});

describe("system prompt composition", () => {
  test("project instructions load from a trusted workspace and stay out of an untrusted one", async () => {
    const run = async (trusted: boolean): Promise<string> => {
      const capture = { systems: [] as string[] };
      const workspaceRoot = tempRoot();
      writeFileSync(join(workspaceRoot, "AGENTS.md"), "Project rule: answer in French.");
      const trustStorePath = join(tempRoot(), "trust.json");
      if (trusted) createFileTrustStore(trustStorePath).trust(workspaceRoot);
      const { client } = await startFakeDaemon({
        workspaceRoot,
        trustStorePath,
        adapterFor: () => textAdapter("ok", capture),
      });
      await client.call("run_turn", {
        turnId: `instr-${trusted}`,
        provider: "anthropic",
        model: "test-model",
        apiKey: "key",
        systemPrompt: "sys",
        session: [],
      });
      return capture.systems[0] ?? "";
    };

    expect(await run(true)).toContain("Project rule: answer in French.");
    expect(await run(false)).not.toContain("Project rule");
  });

  test("plugins and skills of a workspace load only in a trusted workspace, and their text reaches the prompt", async () => {
    const run = async (trusted: boolean): Promise<{ system: string; ran: boolean }> => {
      const capture = { systems: [] as string[] };
      const workspaceRoot = tempRoot();
      const pluginsDir = join(workspaceRoot, ".agency", "plugins");
      mkdirSync(pluginsDir, { recursive: true });
      mkdirSync(join(workspaceRoot, ".agency", "skills", "hello"), { recursive: true });
      // The plugin file writes a marker when it runs. Code of a workspace that the user did not trust must not run.
      writeFileSync(
        join(pluginsDir, "mark.mjs"),
        'import { writeFileSync } from "node:fs";\n' +
          'writeFileSync(new URL("./ran.txt", import.meta.url), "ran");\n' +
          'export default { id: "mark", agentsMd: "Plugin rule: QUARTZ-881." };\n',
      );
      writeFileSync(
        join(workspaceRoot, ".agency", "skills", "hello", "SKILL.md"),
        "---\nname: hello\ndescription: a test skill\n---\n\nSkill rule: ZEPHYR-204.\n",
      );
      const trustStorePath = join(tempRoot(), "trust.json");
      if (trusted) createFileTrustStore(trustStorePath).trust(workspaceRoot);
      const { client } = await startFakeDaemon({
        workspaceRoot,
        trustStorePath,
        adapterFor: () => textAdapter("ok", capture),
      });
      await client.call("run_turn", {
        turnId: `plugins-${trusted}`,
        provider: "anthropic",
        model: "test-model",
        apiKey: "key",
        systemPrompt: "sys",
        session: [],
      });
      return { system: capture.systems[0] ?? "", ran: existsSync(join(pluginsDir, "ran.txt")) };
    };

    const untrusted = await run(false);
    expect(untrusted.ran).toBe(false);
    expect(untrusted.system).not.toContain("a test skill");
    expect(untrusted.system).not.toContain("QUARTZ-881");

    const trusted = await run(true);
    expect(trusted.ran).toBe(true);
    // A skill with a description is one line in the prompt: its body comes through the skill tool.
    expect(trusted.system).toContain("- hello: a test skill");
    expect(trusted.system).not.toContain("ZEPHYR-204");
    expect(trusted.system).toContain("Plugin rule: QUARTZ-881.");
  });

  test("a plain systemPrompt string is used as the base, with the environment block appended", async () => {
    const capture = { systems: [] as string[] };
    const { client, workspaceRoot } = await startFakeDaemon({
      adapterFor: () => textAdapter("ok", capture),
    });

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
    expect(system).toContain(`cwd: ${workspaceRoot}`);
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
      system.indexOf("INSTR1"),
      system.indexOf("ROLE"),
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

    expect(capture.systems[0]).toContain("sys");
    expect(capture.systems[0]).toMatch(/<prompt-version>/);
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
      workspaceRoot: tempRoot(),
      git: () => null,
    });
    expect(system).not.toContain("<system-reminder>");
  });

  test("mcp start failures become mcp_server_down reminders", () => {
    const system = resolveSystemPrompt(params(), {
      workspaceRoot: tempRoot(),
      git: () => null,
      mcpFailures: new Map([["fs", "spawn failed"]]),
    });
    expect(system).toContain('- [mcp_server_down] MCP server "fs" is unavailable: spawn failed');
  });

  test("the git seam feeds branch and dirty state into the environment block", () => {
    const system = resolveSystemPrompt(params(), {
      workspaceRoot: tempRoot(),
      git: (_cwd, args) => (args.includes("status") ? "## main...origin/main\n M a.ts\n" : null),
    });
    expect(system).toContain("git: branch main (dirty, 1 changed file)");
  });

  test("identity falls back to the shared default when parts omit it", () => {
    const system = resolveSystemPrompt(params({ systemPromptParts: { role: "ROLE" } }), {
      workspaceRoot: tempRoot(),
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
      workspaceRoot: tempRoot(),
      git: () => null,
      shellLabel: "PowerShell",
    });
    expect(system).toContain("shell: PowerShell");
  });

  test("no shellLabel means no shell line", () => {
    const system = resolveSystemPrompt(params(), {
      workspaceRoot: tempRoot(),
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
        workspaceRoot: tempRoot(),
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

  test("a native-family provider sends its key to its configured baseUrl, with its headers", async () => {
    const sent: Array<{ url: string; headers: Record<string, string> }> = [];
    const http: HttpClient = {
      fetch: async (url, init) => {
        sent.push({ url: String(url), headers: init?.headers as Record<string, string> });
        return new Response("refused", { status: 400 });
      },
    };
    for (const family of ["anthropic", "openai", "google"] as const) {
      const adapter = resolveAdapter("gateway", {
        gateway: { family, baseUrl: "http://gateway.test/base", headers: { "x-team": "core" } },
      });
      const stream = adapter.stream({ model: "m", apiKey: "gateway-key", messages: [], maxTokens: 16 }, http);
      await (async () => {
        for await (const _ of stream) break;
      })().catch(() => {});
    }
    expect(sent.map((call) => call.url.split("?")[0])).toEqual([
      "http://gateway.test/base/messages",
      "http://gateway.test/base/chat/completions",
      "http://gateway.test/base/models/m:streamGenerateContent",
    ]);
    expect(sent.every((call) => call.headers["x-team"] === "core")).toBe(true);
  });

  test("a builtin id keeps its native adapter when its config entry only holds a key", () => {
    for (const id of ["anthropic", "openai", "google"]) {
      expect(resolveAdapter(id, { [id]: { apiKey: "k" } }).family).toBe(id);
    }
  });

  test("a built-in gateway id sends its key to its own public endpoint without any config", async () => {
    const sent: string[] = [];
    const http: HttpClient = {
      fetch: async (url) => {
        sent.push(String(url));
        return new Response("refused", { status: 400 });
      },
    };
    for (const id of ["openrouter", "deepseek", "groq", "xai"]) {
      const adapter = resolveAdapter(id, {});
      expect(adapter.family).toBe(id);
      const stream = adapter.stream({ model: "m", apiKey: "k", messages: [], maxTokens: 16 }, http);
      await (async () => {
        for await (const _ of stream) break;
      })().catch(() => {});
    }
    expect(sent).toEqual([
      "https://openrouter.ai/api/v1/chat/completions",
      "https://api.deepseek.com/v1/chat/completions",
      "https://api.groq.com/openai/v1/chat/completions",
      "https://api.x.ai/v1/chat/completions",
    ]);
    expect(() => resolveAdapter("no-such-provider", {})).toThrow(/unknown provider/);
  });

  test("a config openai-compatible provider without any baseUrl throws", () => {
    expect(() => resolveAdapter("my-gateway", { "my-gateway": {} })).toThrow(/baseUrl/);
  });

  test("a provider's streamIdleMs goes on its adapter, for a native and for a compatible family", () => {
    const local = { baseUrl: "http://127.0.0.1:8080/v1", streamIdleMs: 900_000 };
    expect(resolveAdapter("local", { local }).streamIdleMs).toBe(900_000);
    expect(resolveAdapter("anthropic", { anthropic: { streamIdleMs: 60_000 } }).streamIdleMs).toBe(60_000);
    expect(resolveAdapter("anthropic", {}).streamIdleMs).toBeUndefined();
  });

  test("an unknown provider with a catalog base URL gets the compatible adapter", () => {
    const adapter = resolveAdapter("together", {}, { together: "https://api.together.xyz/v1" });
    expect(adapter.family).toBe("together");
  });

  test("a fully unknown provider still throws", () => {
    expect(() => resolveAdapter("not-real", {})).toThrow(/unknown provider/);
  });

  test("the error for a provider with no endpoint names the config key that gives it one", () => {
    // The catalog lists glm models, but glm has no built-in endpoint: the id alone told the user nothing to do.
    expect(() => resolveAdapter("glm", {})).toThrow(/provider\.glm\.baseUrl/);
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
    let ask = events1.find((e) => e.type === "approval_requested");
    // Fixed sleeps flake under suite load (event delivery has no latency
    // bound), so poll like the other approval tests instead of asserting once.
    const deadline1 = Date.now() + 15_000;
    while (ask?.requestId === undefined && Date.now() < deadline1) {
      await new Promise((r) => setTimeout(r, 50));
      ask = events1.find((e) => e.type === "approval_requested");
    }
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
    let ask2 = events2.find((e) => e.type === "approval_requested");
    const deadline2 = Date.now() + 15_000;
    while (ask2?.requestId === undefined && Date.now() < deadline2) {
      await new Promise((r) => setTimeout(r, 50));
      ask2 = events2.find((e) => e.type === "approval_requested");
    }
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
      workspaceRoot: tempRoot(),
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
      workspaceRoot: tempRoot(),
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

describe("directly-addressed auto-effort agent classification", () => {
  test("uses the traced small-model pass, not the keyword heuristic", async () => {
    const cfgDir = mkdtempSync(join(tmpdir(), "agency-effort-direct-cfg-"));
    dirs.push(cfgDir);
    writeFileSync(
      join(cfgDir, "config.jsonc"),
      JSON.stringify({
        schemaVersion: 2,
        small_model: "openai/small-classifier",
        agents: {
          leader: {
            role: "GeneralDispatcher",
            provider: "anthropic",
            model: "main-model",
            effort: "low",
            enabled: true,
          },
          worker: {
            role: "Worker",
            provider: "anthropic",
            model: "main-model",
            effort: "auto",
            enabled: true,
          },
        },
      }),
    );
    const approvalsDir = mkdtempSync(join(tmpdir(), "agency-effort-direct-appr-"));
    dirs.push(approvalsDir);
    const classifiedPrompts: string[] = [];
    const mainThinking: unknown[] = [];
    const classifierAdapter: ProviderAdapter = {
      family: "fake",
      async *stream(request) {
        classifiedPrompts.push(
          request.messages
            .map((m) => m.content.map((b) => (b as { text?: string }).text ?? "").join(""))
            .join("\n"),
        );
        yield { type: "text_delta", text: "high" };
        yield { type: "message_stop", stopReason: "end_turn", usage: { inputTokens: 3, outputTokens: 2 } };
      },
    };
    const mainAdapter: ProviderAdapter = {
      family: "fake",
      async *stream(request) {
        mainThinking.push(request.thinkingLevel);
        yield { type: "text_delta", text: "done" };
        yield { type: "message_stop", stopReason: "end_turn", usage: { inputTokens: 3, outputTokens: 2 } };
      },
    };
    const daemon = await createAgentDaemon({
      workspaceRoot: tempRoot(),
      instanceFile: tempInstanceFile(),
      adapterFor: (provider: string) => (provider === "openai" ? classifierAdapter : mainAdapter),
      http: noopHttp,
      approvalsDir,
      configDir: cfgDir,
    });
    daemons.push(daemon);
    const client = await connectToDaemon(daemon.server.port, "127.0.0.1", { token: daemon.server.token });
    clients.push(client);

    // "fix a typo" is what the keyword heuristic scores "low"; the small
    // model says "high" — the turn must run at "high" to prove the model
    // was consulted for this no-dispatcher case.
    await client.call("run_turn", {
      turnId: "effort-direct-1",
      provider: "anthropic",
      model: "main-model",
      apiKey: "key",
      systemPrompt: "sys",
      session: [{ role: "user", content: [{ type: "text", text: "@worker fix a typo" }] }],
    });

    expect(classifiedPrompts.length).toBe(1);
    expect(classifiedPrompts[0]).toContain("Classify the effort");
    expect(mainThinking[0]).toBe("high");
  });
});
