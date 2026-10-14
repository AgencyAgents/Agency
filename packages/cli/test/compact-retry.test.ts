import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compactionPrompt, SessionStore, type ToolSpec } from "@agency/core";
import type { HttpClient } from "@agency/net";
import type { ProviderAdapter, StreamEvent } from "@agency/providers";
import { connectToDaemon, type DaemonClient } from "@agency/rpc";
import { AgencyError, ErrorCode } from "@agency/schema";
import { type AgentDaemon, createAgentDaemon } from "../src/daemon.ts";
import { runSessionTurn } from "../src/session-runner.ts";

const noopHttp: HttpClient = { fetch: async () => new Response() };
const daemons: AgentDaemon[] = [];
const clients: DaemonClient[] = [];
const dirs: string[] = [];

const prev = process.env.AGENCY_ANTHROPIC_API_KEY;
process.env.AGENCY_ANTHROPIC_API_KEY = "test-key-compact";
afterAll(() => {
  if (prev === undefined) delete process.env.AGENCY_ANTHROPIC_API_KEY;
  else process.env.AGENCY_ANTHROPIC_API_KEY = prev;
});
afterEach(async () => {
  for (const c of clients.splice(0)) await c.close();
  for (const d of daemons.splice(0)) await d.stop();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}

function compactingAdapter(): ProviderAdapter {
  let calls = 0;
  return {
    family: "fake",
    async *stream(): AsyncIterable<StreamEvent> {
      calls += 1;
      if (calls === 1) {
        throw new AgencyError(ErrorCode.CONTEXT_OVERFLOW, "prompt is too long", { source: "fake" });
      }
      yield { type: "text_delta", text: "recovered after compaction" };
      yield { type: "message_stop", stopReason: "end_turn", usage: { inputTokens: 5, outputTokens: 5 } };
    },
  };
}

async function daemon(ws: string, adapter: ProviderAdapter, sessionsDir: string, tools: ToolSpec[] = []) {
  const d = await createAgentDaemon({
    workspaceRoot: ws,
    instanceFile: join(ws, ".agency", "instance.json"),
    sessionsDir,
    adapterFor: () => adapter,
    http: noopHttp,
    tools,
  });
  daemons.push(d);
  const c = await connectToDaemon(d.server.port, "127.0.0.1", { token: d.server.token });
  clients.push(c);
  return c;
}

describe("compact-and-retry branch", () => {
  test("reactive onContextOverflow compacts daemon-side and the turn continues", async () => {
    const ws = tmp("agency-compact-ws-");
    const sessionsDir = tmp("agency-compact-sess-");
    const seed = new SessionStore(sessionsDir);
    seed.create("s1");

    // Below the proactive trigger: the overflow comes from the provider, so
    // the reactive compact-and-retry path handles it inside session_send.
    let parent: string | null = null;
    for (let i = 0; i < 6; i++) {
      const e = await seed.append("s1", {
        type: "message",
        parentId: parent,
        message: { role: "user", content: [{ type: "text", text: `history ${i} ${"x".repeat(800)}` }] },
      });
      parent = e.id;
    }

    const client = await daemon(ws, compactingAdapter(), sessionsDir);

    const { result, tipId } = await runSessionTurn(client, {
      sessionId: "s1",
      provider: "anthropic",
      model: "test-model",
      systemPrompt: "sys",
      userText: "continue after overflow",
    });

    expect(result.stopReason).toBe("end_turn");
    expect(
      result.messages.some((m) => JSON.stringify(m.content).includes("recovered after compaction")),
    ).toBe(true);

    const entries = new SessionStore(sessionsDir).load("s1");
    const chain = new SessionStore(sessionsDir).chainFor(entries, tipId);
    expect(chain.some((e) => e.type === "compaction_summary")).toBe(true);
    expect(
      chain.some((e) => e.type === "message" && JSON.stringify(e).includes("continue after overflow")),
    ).toBe(true);
  }, 15000);

  test("an overflow in the middle of a turn keeps the steps of that turn", async () => {
    const ws = tmp("agency-compact-ws-");
    const sessionsDir = tmp("agency-compact-sess-");
    const seed = new SessionStore(sessionsDir);
    seed.create("s1");
    let parent: string | null = null;
    for (let i = 0; i < 6; i++) {
      const e = await seed.append("s1", {
        type: "message",
        parentId: parent,
        message: { role: "user", content: [{ type: "text", text: `history ${i} ${"x".repeat(800)}` }] },
      });
      parent = e.id;
    }

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
    let overflowed = false;
    const adapter: ProviderAdapter = {
      family: "fake",
      async *stream(request): AsyncIterable<StreamEvent> {
        const stepDone = request.messages.some((m) => m.content.some((b) => b.type === "tool_result"));
        if (!stepDone) {
          yield { type: "tool_call_start", id: "c1", name: "count" };
          yield { type: "tool_call_delta", id: "c1", inputJsonDelta: "{}" };
          yield { type: "tool_call_end", id: "c1" };
          yield { type: "message_stop", stopReason: "tool_use", usage: { inputTokens: 5, outputTokens: 5 } };
          return;
        }
        if (!overflowed) {
          overflowed = true;
          throw new AgencyError(ErrorCode.CONTEXT_OVERFLOW, "prompt is too long", { source: "fake" });
        }
        yield { type: "text_delta", text: "done after compaction" };
        yield { type: "message_stop", stopReason: "end_turn", usage: { inputTokens: 5, outputTokens: 5 } };
      },
    };
    const client = await daemon(ws, adapter, sessionsDir, [countTool]);

    const { result, tipId } = await runSessionTurn(client, {
      sessionId: "s1",
      provider: "anthropic",
      model: "test-model",
      systemPrompt: "sys",
      userText: "count once",
    });

    expect(result.stopReason).toBe("end_turn");
    expect(runs).toBe(1);
    const store = new SessionStore(sessionsDir);
    const stored = JSON.stringify(store.messagesFor(store.load("s1"), tipId));
    expect(stored).toContain("run 1");
    expect(stored).toContain("done after compaction");
  }, 15000);

  /** A session of six long messages, and a model that writes "MODEL-SUMMARY" when asked for a summary. */
  async function summarySetup() {
    const ws = tmp("agency-summary-ws-");
    const sessionsDir = tmp("agency-summary-sess-");
    const seed = new SessionStore(sessionsDir);
    seed.create("s1");
    let parent: string | null = null;
    for (let i = 0; i < 6; i++) {
      const e = await seed.append("s1", {
        type: "message",
        parentId: parent,
        message: {
          role: i % 2 === 0 ? "user" : "assistant",
          content: [{ type: "text", text: `history ${i} ${"word ".repeat(300)}` }],
        },
      });
      parent = e.id;
    }
    const summaryInputs: string[] = [];
    const turnInputs: string[] = [];
    const adapter: ProviderAdapter = {
      family: "fake",
      async *stream(request): AsyncIterable<StreamEvent> {
        const summary = request.system === compactionPrompt();
        (summary ? summaryInputs : turnInputs).push(JSON.stringify(request.messages));
        yield { type: "text_delta", text: summary ? "MODEL-SUMMARY of the port change" : "ok" };
        yield { type: "message_stop", stopReason: "end_turn", usage: { inputTokens: 5, outputTokens: 5 } };
      },
    };
    return { client: await daemon(ws, adapter, sessionsDir), sessionsDir, summaryInputs, turnInputs };
  }

  test("a session near its window is compacted with a summary that the model wrote", async () => {
    const { client, summaryInputs, turnInputs } = await summarySetup();
    await runSessionTurn(client, {
      sessionId: "s1",
      provider: "anthropic",
      model: "test-model",
      systemPrompt: "sys",
      userText: "go on",
      // Six messages of about 300 tokens each are above 90 percent of this window.
      contextWindow: 1500,
    });
    expect(summaryInputs).toHaveLength(1);
    expect(summaryInputs[0]).toContain("history 0");
    expect(turnInputs[0]).toContain("MODEL-SUMMARY of the port change");
    expect(turnInputs[0]).not.toContain("history 0");
  }, 15000);

  test("the compact command compacts a session that is far below its window", async () => {
    const { client, sessionsDir, summaryInputs } = await summarySetup();
    const out = (await client.call("command_run", { name: "compact", args: "s1 anthropic/test-model" })) as {
      data: { compacted: boolean; tipId: string };
    };
    expect(out.data.compacted).toBe(true);
    expect(summaryInputs).toHaveLength(1);
    const store = new SessionStore(sessionsDir);
    expect(JSON.stringify(store.messagesFor(store.load("s1"), out.data.tipId))).toContain("MODEL-SUMMARY");
  }, 15000);

  test("session_send takes the caller's step limit and reports when the turn reaches it", async () => {
    const ws = tmp("agency-steps-ws-");
    const sessionsDir = tmp("agency-steps-sess-");
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
    const adapter: ProviderAdapter = {
      family: "fake",
      async *stream(): AsyncIterable<StreamEvent> {
        yield { type: "tool_call_start", id: `c${runs}`, name: "count" };
        yield { type: "tool_call_delta", id: `c${runs}`, inputJsonDelta: "{}" };
        yield { type: "tool_call_end", id: `c${runs}` };
        yield { type: "message_stop", stopReason: "tool_use", usage: { inputTokens: 1, outputTokens: 1 } };
      },
    };
    const client = await daemon(ws, adapter, sessionsDir, [countTool]);

    const result = (await client.call("session_send", {
      sessionId: "steps",
      provider: "anthropic",
      model: "m",
      systemPrompt: "sys",
      userText: "count for ever",
      maxToolIterations: 2,
    })) as { error?: { code: string } };

    expect(runs).toBe(2);
    expect(result.error?.code).toBe("iteration_limit");
  }, 20000);

  test("the config sets the step limit of a turn and the request rate of a provider", async () => {
    const stepsUntilLimit = async (configDir: string): Promise<number> => {
      const ws = tmp("agency-maxsteps-ws-");
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
      const adapter: ProviderAdapter = {
        family: "fake",
        async *stream(): AsyncIterable<StreamEvent> {
          yield { type: "tool_call_start", id: `c${runs}`, name: "count" };
          yield { type: "tool_call_delta", id: `c${runs}`, inputJsonDelta: "{}" };
          yield { type: "tool_call_end", id: `c${runs}` };
          yield { type: "message_stop", stopReason: "tool_use", usage: { inputTokens: 1, outputTokens: 1 } };
        },
      };
      const d = await createAgentDaemon({
        workspaceRoot: ws,
        instanceFile: join(ws, ".agency", "instance.json"),
        sessionsDir: tmp("agency-maxsteps-sess-"),
        configDir,
        adapterFor: () => adapter,
        http: noopHttp,
        tools: [countTool],
      });
      daemons.push(d);
      const c = await connectToDaemon(d.server.port, "127.0.0.1", { token: d.server.token });
      clients.push(c);
      const result = (await c.call("session_send", {
        sessionId: "steps",
        provider: "anthropic",
        model: "m",
        systemPrompt: "sys",
        userText: "count for ever",
      })) as { error?: { code: string } };
      expect(result.error?.code).toBe("iteration_limit");
      return runs;
    };
    const configDir = tmp("agency-maxsteps-cfg-");
    writeFileSync(join(configDir, "config.jsonc"), JSON.stringify({ maxSteps: 3 }));
    expect(await stepsUntilLimit(configDir)).toBe(3);

    // At the default rate of 60 requests a minute, 100 steps take more than 90 seconds.
    const fast = tmp("agency-maxsteps-fast-");
    writeFileSync(
      join(fast, "config.jsonc"),
      JSON.stringify({ maxSteps: 100, provider: { anthropic: { requestsPerMinute: 1_000_000 } } }),
    );
    expect(await stepsUntilLimit(fast)).toBe(100);
  }, 20000);

  test("a send that waits behind another turn does not run after its client has left", async () => {
    const ws = tmp("agency-queue-ws-");
    const sessionsDir = tmp("agency-queue-sess-");
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const prompts: string[] = [];
    const adapter: ProviderAdapter = {
      family: "fake",
      async *stream(request): AsyncIterable<StreamEvent> {
        prompts.push(JSON.stringify(request.messages.at(-1)?.content));
        if (prompts.length === 1) await held;
        yield { type: "text_delta", text: "ok" };
        yield { type: "message_stop", stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1 } };
      },
    };
    const first = await daemon(ws, adapter, sessionsDir);
    const port = daemons.at(-1)?.server.port as number;
    const second = await connectToDaemon(port, "127.0.0.1", { token: daemons.at(-1)?.server.token });
    const send = (client: DaemonClient, userText: string) =>
      client.call("session_send", {
        sessionId: "q1",
        provider: "anthropic",
        model: "m",
        systemPrompt: "sys",
        userText,
      });

    const running = send(first, "first");
    const deadline = Date.now() + 10_000;
    while (prompts.length < 1 && Date.now() < deadline) await Bun.sleep(10);
    const waiting = send(second, "second").catch(() => "rejected");
    await Bun.sleep(100);
    await second.close();
    await Bun.sleep(100);
    release();
    await running;
    await waiting;
    await Bun.sleep(300);

    expect(prompts).toHaveLength(1);
    expect(JSON.stringify(new SessionStore(sessionsDir).load("q1"))).not.toContain("second");
  }, 20000);

  test("retry events: scheduler onRetry flows to LoopEvent retry event via runSessionTurn", async () => {
    const ws = tmp("agency-retry-ws-");
    const sessionsDir = tmp("agency-retry-sess-");
    let attempts = 0;
    const adapter: ProviderAdapter = {
      family: "fake",
      async *stream(): AsyncIterable<StreamEvent> {
        attempts += 1;
        if (attempts < 3) throw new AgencyError(ErrorCode.TRANSIENT, "flaky", { source: "fake" });
        yield { type: "text_delta", text: "ok after retries" };
        yield { type: "message_stop", stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1 } };
      },
    };
    const client = await daemon(ws, adapter, sessionsDir);
    const events: unknown[] = [];
    const { result } = await runSessionTurn(client, {
      sessionId: "s2",
      provider: "anthropic",
      model: "m",
      systemPrompt: "sys",
      userText: "hello",
      onEvent: (e) => events.push(e),
    });
    expect(result.stopReason).toBe("end_turn");
    const retries = events.filter((e) => (e as { type: string }).type === "retry");
    expect(retries.length).toBeGreaterThanOrEqual(1);
  }, 15000);
});

describe("/compact with instructions", () => {
  test("the words after the session and the model go to the model that writes the summary", async () => {
    const ws = tmp("agency-compact-ws-");
    const sessionsDir = tmp("agency-compact-sess-");
    const seed = new SessionStore(sessionsDir);
    seed.create("s1");
    let parent: string | null = null;
    for (let i = 0; i < 8; i++) {
      const e = await seed.append("s1", {
        type: "message",
        parentId: parent,
        message: { role: "user", content: [{ type: "text", text: `history ${i} ${"x".repeat(200)}` }] },
      });
      parent = e.id;
    }
    const systems: string[] = [];
    const adapter: ProviderAdapter = {
      family: "fake",
      async *stream(request): AsyncIterable<StreamEvent> {
        systems.push(request.system ?? "");
        yield { type: "text_delta", text: "the summary" };
        yield { type: "message_stop", stopReason: "end_turn", usage: { inputTokens: 5, outputTokens: 5 } };
      },
    };
    const client = await daemon(ws, adapter, sessionsDir);
    const out = (await client.call("command_run", {
      name: "compact",
      args: "s1 anthropic/test-model keep every file name",
    })) as { data: { compacted: boolean } };
    expect(out.data.compacted).toBe(true);
    expect(systems.length).toBeGreaterThan(0);
    expect(systems[0]).toContain("keep every file name");
    expect(systems[0]).not.toContain("anthropic/test-model");
  });
});
