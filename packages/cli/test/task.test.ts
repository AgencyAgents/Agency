import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HttpClient } from "@agency/net";
import type { ProviderAdapter, StreamEvent } from "@agency/providers";
import { SessionStore } from "@agency/core";
import { connectToDaemon, type DaemonClient } from "@agency/rpc";
import { createAgentDaemon, type AgentDaemon, type RunTurnRpcResult } from "../src/daemon.ts";

const noopHttp: HttpClient = { fetch: async () => new Response() };
const daemons: AgentDaemon[] = [];
const clients: DaemonClient[] = [];
const dirs: string[] = [];

afterEach(async () => {
  for (const c of clients.splice(0)) await c.close().catch(() => {});
  for (const d of daemons.splice(0)) await d.stop().catch(() => {});
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "agency-task-"));
  dirs.push(dir);
  return dir;
}

function sessionsDirFor(root: string): string {
  const { storagePaths } = require("@agency/core");
  return storagePaths(root).sessionsDir;
}

function findToolResultContent(messages: Array<{ role: string; content: Array<{ type: string; content?: string; text?: string }> }>): string {
  const msg = messages.find((m) => m.role === "user" && m.content.some((b) => b.type === "tool_result"));
  const block = msg?.content.find((b) => b.type === "tool_result") as { content?: string } | undefined;
  return block?.content ?? "";
}

describe("task ephemeral workers", () => {
  test("basic round-trip: spawns child, isolated prompt, returns final text, auditable", async () => {
    const root = tempRepo();
    const adapter: ProviderAdapter = {
      family: "fake",
      async *stream(request): AsyncIterable<StreamEvent> {
        const hasToolResult = request.messages.some((m) => m.content.some((b) => (b as { type: string }).type === "tool_result"));
        const lastUser = [...request.messages].reverse().find((m) => m.role === "user");
        const txt = (lastUser?.content.find((b) => (b as { type: string }).type === "text") as { text?: string } | undefined)?.text ?? "";
        if (txt.startsWith("worker task")) {
          yield { type: "text_delta", text: "worker done: hello" };
          yield { type: "message_stop", stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1 } };
          return;
        }
        if (!hasToolResult) {
          yield { type: "tool_call_start", id: "c1", name: "task" };
          yield { type: "tool_call_delta", id: "c1", inputJsonDelta: JSON.stringify({ prompt: "worker task hello" }) };
          yield { type: "tool_call_end", id: "c1" };
          yield { type: "message_stop", stopReason: "tool_use", usage: { inputTokens: 1, outputTokens: 1 } };
        } else {
          yield { type: "text_delta", text: "parent done" };
          yield { type: "message_stop", stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1 } };
        }
      },
    };
    const daemon = await createAgentDaemon({
      workspaceRoot: root,
      instanceFile: join(root, ".agency", "instance.json"),
      adapterFor: () => adapter,
      http: noopHttp,
    });
    daemons.push(daemon);
    const client = await connectToDaemon(daemon.server.port, "127.0.0.1", { token: daemon.server.token });
    clients.push(client);

    const sdir = sessionsDirFor(root);
    const store = new SessionStore(sdir);
    const sessionId = "test-basic";

    const result = (await client.call("run_turn", {
      turnId: "t-basic",
      provider: "anthropic",
      model: "test-model",
      apiKey: "key",
      systemPrompt: "sys",
      session: [],
      sessionId,
    })) as RunTurnRpcResult;

    expect(result.stopReason).toBe("end_turn");
    expect(findToolResultContent(result.messages)).toContain("worker done: hello");

    const entries = store.load(sessionId);
    const taskResults = entries.filter((e) => e.type === "task_result");
    expect(taskResults.length).toBe(1);
    const tr = taskResults[0] as unknown as { childSessionId: string; childTurnId: string; summary: string };
    expect(typeof tr.childSessionId).toBe("string");
    expect(tr.summary).toContain("worker done");

    const childEntries = store.load(tr.childSessionId);
    expect(childEntries.length).toBeGreaterThan(0);
    expect(childEntries.some((e) => e.type === "message")).toBe(true);

    const tracePath = join(sdir, `${tr.childSessionId}.trace.jsonl`);
    expect(existsSync(tracePath)).toBe(true);
    const cassettePath = join(sdir, `${tr.childSessionId}.${tr.childTurnId}.cassette.json`);
    expect(existsSync(cassettePath)).toBe(true);
  });

  test("depth denial: nested task denied with clean error", async () => {
    const root = tempRepo();
    const nestedAdapter: ProviderAdapter = {
      family: "fake",
      async *stream(req): AsyncIterable<StreamEvent> {
        const msgs = req.messages;
        const hasTR = msgs.some((m) => m.content.some((b) => (b as { type: string }).type === "tool_result"));
        const lastUser = [...msgs].reverse().find((m) => m.role === "user");
        const txt = (lastUser?.content.find((b) => (b as { type: string }).type === "text") as { text?: string } | undefined)?.text ?? "";
        const toolResultContent = (() => {
          const m = msgs.find((x) => x.role === "user" && x.content.some((b) => (b as { type: string }).type === "tool_result"));
          return (m?.content.find((b) => (b as { type: string }).type === "tool_result") as { content?: string } | undefined)?.content ?? "";
        })();
        if (txt === "outer prompt") {
          if (!hasTR) {
            yield { type: "tool_call_start", id: "c1", name: "task" };
            yield { type: "tool_call_delta", id: "c1", inputJsonDelta: JSON.stringify({ prompt: "inner" }) };
            yield { type: "tool_call_end", id: "c1" };
            yield { type: "message_stop", stopReason: "tool_use", usage: { inputTokens: 1, outputTokens: 1 } };
            return;
          } else {
            yield { type: "text_delta", text: `child saw: ${toolResultContent}` };
            yield { type: "message_stop", stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1 } };
            return;
          }
        }
        if (txt === "" && !hasTR) {
          yield { type: "tool_call_start", id: "c0", name: "task" };
          yield { type: "tool_call_delta", id: "c0", inputJsonDelta: JSON.stringify({ prompt: "outer prompt" }) };
          yield { type: "tool_call_end", id: "c0" };
          yield { type: "message_stop", stopReason: "tool_use", usage: { inputTokens: 1, outputTokens: 1 } };
          return;
        }
        if (hasTR && txt === "") {
          yield { type: "text_delta", text: `parent saw child: ${toolResultContent}` };
          yield { type: "message_stop", stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1 } };
          return;
        }
        // inner attempt child that tries nested task - this will be for txt === "inner"
        if (txt === "inner") {
          if (!hasTR) {
            yield { type: "tool_call_start", id: "c2", name: "task" };
            yield { type: "tool_call_delta", id: "c2", inputJsonDelta: JSON.stringify({ prompt: "should be denied" }) };
            yield { type: "tool_call_end", id: "c2" };
            yield { type: "message_stop", stopReason: "tool_use", usage: { inputTokens: 1, outputTokens: 1 } };
            return;
          } else {
            yield { type: "text_delta", text: `inner child saw: ${toolResultContent}` };
            yield { type: "message_stop", stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1 } };
            return;
          }
        }
        yield { type: "text_delta", text: "fallback" };
        yield { type: "message_stop", stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1 } };
      },
    };
    const daemon = await createAgentDaemon({
      workspaceRoot: root,
      instanceFile: join(root, ".agency", "instance.json"),
      adapterFor: () => nestedAdapter,
      http: noopHttp,
    });
    daemons.push(daemon);
    const client = await connectToDaemon(daemon.server.port, "127.0.0.1", { token: daemon.server.token });
    clients.push(client);

    const result = (await client.call("run_turn", {
      turnId: "t-depth",
      provider: "anthropic",
      model: "test-model",
      apiKey: "key",
      systemPrompt: "sys",
      session: [{ role: "user", content: [{ type: "text", text: "" }] }],
      sessionId: "test-depth",
    })) as RunTurnRpcResult;

    const parentTR = findToolResultContent(result.messages);
    expect(parentTR).toContain("depth limit");
  });

  test("tool restriction honored: allowlist limits child tools", async () => {
    const root = tempRepo();
    const adapter: ProviderAdapter = {
      family: "fake",
      async *stream(request): AsyncIterable<StreamEvent> {
        const hasTR = request.messages.some((m) => m.content.some((b) => (b as { type: string }).type === "tool_result"));
        const lastUser = [...request.messages].reverse().find((m) => m.role === "user");
        const txt = (lastUser?.content.find((b) => (b as { type: string }).type === "text") as { text?: string } | undefined)?.text ?? "";
        const toolResultContent = (() => {
          const m = request.messages.find((x) => x.role === "user" && x.content.some((b) => (b as { type: string }).type === "tool_result"));
          return (m?.content.find((b) => (b as { type: string }).type === "tool_result") as { content?: string } | undefined)?.content ?? "";
        })();
        if (txt === "restricted task") {
          if (!hasTR) {
            yield { type: "tool_call_start", id: "c1", name: "bash" };
            yield { type: "tool_call_delta", id: "c1", inputJsonDelta: JSON.stringify({ command: "echo should be denied" }) };
            yield { type: "tool_call_end", id: "c1" };
            yield { type: "message_stop", stopReason: "tool_use", usage: { inputTokens: 1, outputTokens: 1 } };
            return;
          } else {
            yield { type: "text_delta", text: `child saw bash result: ${toolResultContent}` };
            yield { type: "message_stop", stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1 } };
            return;
          }
        }
        if (!hasTR && txt === "") {
          yield { type: "tool_call_start", id: "c0", name: "task" };
          yield {
            type: "tool_call_delta",
            id: "c0",
            inputJsonDelta: JSON.stringify({ prompt: "restricted task", tools: ["read"] }),
          };
          yield { type: "tool_call_end", id: "c0" };
          yield { type: "message_stop", stopReason: "tool_use", usage: { inputTokens: 1, outputTokens: 1 } };
          return;
        }
        if (hasTR) {
          yield { type: "text_delta", text: `parent saw ${toolResultContent}` };
          yield { type: "message_stop", stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1 } };
          return;
        }
        yield { type: "text_delta", text: "fallback" };
        yield { type: "message_stop", stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1 } };
      },
    };
    const daemon = await createAgentDaemon({
      workspaceRoot: root,
      instanceFile: join(root, ".agency", "instance.json"),
      adapterFor: () => adapter,
      http: noopHttp,
    });
    daemons.push(daemon);
    const client = await connectToDaemon(daemon.server.port, "127.0.0.1", { token: daemon.server.token });
    clients.push(client);

    const result = (await client.call("run_turn", {
      turnId: "t-restrict",
      provider: "anthropic",
      model: "test-model",
      apiKey: "key",
      systemPrompt: "sys",
      session: [{ role: "user", content: [{ type: "text", text: "" }] }],
      sessionId: "test-restrict",
    })) as RunTurnRpcResult;

    const parentTR = findToolResultContent(result.messages);
    expect(parentTR).toContain("no such tool");
  });

  test("parallel tasks: two tasks in same round run concurrently and isolated", async () => {
    const root = tempRepo();
    writeFileSync(join(root, "a.txt"), "A");
    writeFileSync(join(root, "b.txt"), "B");
    // Deterministic concurrency proof via shared barrier: each child awaits a
    // Promise that resolves only after BOTH children have started. If tasks ran
    // sequentially, the first would deadlock waiting for the second to start.
    // Completion of both therefore proves overlap without any wall-clock threshold.
    let startedCount = 0;
    let barrierResolve!: () => void;
    const barrier = new Promise<void>((resolve) => {
      barrierResolve = resolve;
    });
    const adapter: ProviderAdapter = {
      family: "fake",
      async *stream(request): AsyncIterable<StreamEvent> {
        const hasTR = request.messages.some((m) => m.content.some((b) => (b as { type: string }).type === "tool_result"));
        const lastUser = [...request.messages].reverse().find((m) => m.role === "user");
        const txt = (lastUser?.content.find((b) => (b as { type: string }).type === "text") as { text?: string } | undefined)?.text ?? "";
        if (txt === "task A") {
          startedCount++;
          if (startedCount === 2) barrierResolve();
          await barrier;
          yield { type: "text_delta", text: "result A" };
          yield { type: "message_stop", stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1 } };
          return;
        }
        if (txt === "task B") {
          startedCount++;
          if (startedCount === 2) barrierResolve();
          await barrier;
          yield { type: "text_delta", text: "result B" };
          yield { type: "message_stop", stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1 } };
          return;
        }
        if (!hasTR && txt === "") {
          yield { type: "tool_call_start", id: "c1", name: "task" };
          yield { type: "tool_call_delta", id: "c1", inputJsonDelta: JSON.stringify({ prompt: "task A" }) };
          yield { type: "tool_call_end", id: "c1" };
          yield { type: "tool_call_start", id: "c2", name: "task" };
          yield { type: "tool_call_delta", id: "c2", inputJsonDelta: JSON.stringify({ prompt: "task B" }) };
          yield { type: "tool_call_end", id: "c2" };
          yield { type: "message_stop", stopReason: "tool_use", usage: { inputTokens: 1, outputTokens: 1 } };
          return;
        }
        if (hasTR) {
          const msgs = request.messages.find((m) => m.role === "user" && m.content.some((b) => (b as { type: string }).type === "tool_result"));
          const results = (msgs?.content.filter((b) => (b as { type: string }).type === "tool_result") as Array<{ content: string }>) ?? [];
          const joined = results.map((r) => r.content).join("|");
          yield { type: "text_delta", text: `parent both: ${joined}` };
          yield { type: "message_stop", stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1 } };
          return;
        }
      },
    };
    const daemon = await createAgentDaemon({
      workspaceRoot: root,
      instanceFile: join(root, ".agency", "instance.json"),
      adapterFor: () => adapter,
      http: noopHttp,
    });
    daemons.push(daemon);
    const client = await connectToDaemon(daemon.server.port, "127.0.0.1", { token: daemon.server.token });
    clients.push(client);

    const result = (await client.call("run_turn", {
      turnId: "t-parallel",
      provider: "anthropic",
      model: "test-model",
      apiKey: "key",
      systemPrompt: "sys",
      session: [{ role: "user", content: [{ type: "text", text: "" }] }],
      sessionId: "test-parallel",
    })) as RunTurnRpcResult;

    const toolResultsMsg = result.messages.find((m) => m.role === "user" && m.content.some((b) => (b as { type: string }).type === "tool_result"));
    const toolResults = (toolResultsMsg?.content.filter((b) => (b as { type: string }).type === "tool_result") as Array<{ content: string; type: string }>) ?? [];
    expect(toolResults).toHaveLength(2);
    const contents = toolResults.map((r) => r.content);
    expect(contents).toEqual(expect.arrayContaining([expect.stringContaining("result A"), expect.stringContaining("result B")]));

    // Barrier proof: both handlers must have started and been unblocked together.
    expect(startedCount).toBe(2);

    const sdir = sessionsDirFor(root);
    const store = new SessionStore(sdir);
    const entries = store.load("test-parallel");
    const taskResults = entries.filter((e) => e.type === "task_result");
    expect(taskResults.length).toBe(2);
    const childIds = taskResults.map((e) => (e as unknown as { childSessionId: string }).childSessionId);
    expect(new Set(childIds).size).toBe(2);
    for (const cid of childIds) {
      const ce = store.load(cid);
      expect(ce.some((e) => e.type === "message")).toBe(true);
    }
  });
});
