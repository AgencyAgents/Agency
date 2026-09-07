import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolSpec } from "@agency/core";
import type { HttpClient } from "@agency/net";
import type { ProviderAdapter, StreamEvent } from "@agency/providers";
import { RPC_METHODS } from "@agency/rpc";
import { type AgentDaemon, createAgentDaemon } from "../src/daemon.ts";

const noopHttp: HttpClient = { fetch: async () => new Response() };
const daemons: AgentDaemon[] = [];
const dirs: string[] = [];

const prevKey = process.env.AGENCY_ANTHROPIC_API_KEY;
process.env.AGENCY_ANTHROPIC_API_KEY = "test-key-surface";
const prevOffline = process.env.AGENCY_DISABLE_MODELS_FETCH;
process.env.AGENCY_DISABLE_MODELS_FETCH = "1";
afterAll(() => {
  if (prevKey === undefined) delete process.env.AGENCY_ANTHROPIC_API_KEY;
  else process.env.AGENCY_ANTHROPIC_API_KEY = prevKey;
  if (prevOffline === undefined) delete process.env.AGENCY_DISABLE_MODELS_FETCH;
  else process.env.AGENCY_DISABLE_MODELS_FETCH = prevOffline;
});

afterEach(async () => {
  for (const daemon of daemons.splice(0)) await daemon.stop();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

function echoAdapter(reply = "ok"): ProviderAdapter {
  return {
    family: "fake",
    async *stream(): AsyncIterable<StreamEvent> {
      yield { type: "text_delta", text: reply };
      yield { type: "message_stop", stopReason: "end_turn", usage: { inputTokens: 5, outputTokens: 5 } };
    },
  };
}

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

const dangerousTool: ToolSpec = {
  name: "fakebash",
  description: "fake dangerous tool",
  inputSchema: { type: "object", properties: { command: { type: "string" } } },
  riskTier: "dangerous",
  handler: async (input) => ({ content: `ran ${String((input as { command?: string }).command)}` }),
};

async function startDaemon(opts: { adapter?: ProviderAdapter; tools?: ToolSpec[] } = {}) {
  const workspaceRoot = tempDir("agency-surface-ws-");
  const daemon = await createAgentDaemon({
    workspaceRoot,
    instanceFile: join(workspaceRoot, ".agency", "instance.json"),
    sessionsDir: tempDir("agency-surface-sess-"),
    approvalsDir: tempDir("agency-surface-appr-"),
    adapterFor: () => opts.adapter ?? echoAdapter(),
    http: noopHttp,
    tools: opts.tools ?? [],
  });
  daemons.push(daemon);
  return { daemon, base: `http://127.0.0.1:${daemon.httpPort}`, token: daemon.server.token as string };
}

async function rpcCall(
  base: string,
  token: string,
  method: string,
  params: Record<string, unknown> = {},
): Promise<{ status: number; body: { result?: unknown; error?: { message: string } } }> {
  const res = await fetch(`${base}/rpc`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ id: `req-${method}`, method, params }),
  });
  return {
    status: res.status,
    body: (await res.json()) as { result?: unknown; error?: { message: string } },
  };
}

async function rpcOk(
  base: string,
  token: string,
  method: string,
  params: Record<string, unknown> = {},
): Promise<unknown> {
  const { status, body } = await rpcCall(base, token, method, params);
  if (status !== 200 || body.error !== undefined || body.result === undefined) {
    throw new Error(`rpc ${method} failed (${status}): ${JSON.stringify(body)}`);
  }
  return body.result;
}

async function readStateFrame(
  base: string,
  token: string,
  sessionId: string,
): Promise<Record<string, unknown>> {
  const res = await fetch(`${base}/events?sessionId=${sessionId}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (res.status !== 200 || !res.body) throw new Error(`SSE subscribe failed: ${res.status}`);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let acc = "";
  try {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline && !acc.includes("event: state")) {
      const remaining = deadline - Date.now();
      let timerId: ReturnType<typeof setTimeout> | undefined;
      const timer = new Promise<"timeout">((resolve) => {
        timerId = setTimeout(() => resolve("timeout"), remaining);
      });
      try {
        const result = await Promise.race([reader.read(), timer]);
        if (result === "timeout" || result.done) break;
        acc += decoder.decode(result.value, { stream: true });
      } finally {
        clearTimeout(timerId);
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  const match = acc.match(/^event: state\ndata: (.*)$/m);
  if (!match) throw new Error(`no state frame; got: ${JSON.stringify(acc.slice(0, 300))}`);
  return JSON.parse(match[1] ?? "{}") as Record<string, unknown>;
}

describe("Phase 10a surface contract", () => {
  test("/doc and the handler table match method-for-method", async () => {
    const { base, token } = await startDaemon();
    const res = await fetch(`${base}/doc`, { headers: { Authorization: `Bearer ${token}` } });
    expect(res.status).toBe(200);
    const doc = (await res.json()) as {
      "x-agency": { protocolVersion: number; methods: { name: string }[]; events: { name: string }[] };
    };
    expect(doc["x-agency"].protocolVersion).toBe(2);
    expect(doc["x-agency"].events.length).toBeGreaterThan(0);
    const docMethods = doc["x-agency"].methods.map((m) => m.name).sort();
    expect(docMethods).toEqual([...RPC_METHODS].sort());
    for (const method of RPC_METHODS) {
      const { status } = await rpcCall(base, token, method);
      expect(status).not.toBe(404);
    }
  }, 30_000);

  test("every handler has an SDK method in generated.ts", async () => {
    const generated = readFileSync(join(import.meta.dir, "../../sdk/src/generated.ts"), "utf8");
    for (const method of RPC_METHODS) {
      expect(generated).toContain(`\n  ${method}(`);
    }
    expect(generated).toContain("createSurfaceClient");
    expect(generated).toContain("GatewayEvent");
  });

  test("session_create, session_list, session_rename, session_export", async () => {
    const { base, token } = await startDaemon();
    const created = (await rpcOk(base, token, "session_create", { sessionId: "c1" })) as {
      sessionId: string;
    };
    expect(created.sessionId).toBe("c1");
    const listed = (await rpcOk(base, token, "session_list")) as {
      sessions: { id: string; entries: number }[];
    };
    expect(listed.sessions.map((s) => s.id)).toContain("c1");

    await rpcOk(base, token, "session_send", {
      sessionId: "c1",
      provider: "anthropic",
      model: "test-model",
      systemPrompt: "sys",
      userText: "hello",
    });
    const exported = (await rpcOk(base, token, "session_export", { sessionId: "c1" })) as {
      entries: unknown[];
    };
    expect(exported.entries).toHaveLength(3);

    const renamed = (await rpcOk(base, token, "session_rename", {
      sessionId: "c1",
      newSessionId: "c2",
    })) as { sessionId: string };
    expect(renamed.sessionId).toBe("c2");
    const afterRename = (await rpcOk(base, token, "session_show", { sessionId: "c2" })) as {
      entries: unknown[];
    };
    expect(afterRename.entries).toHaveLength(3);
    const oldGone = await rpcCall(base, token, "session_show", { sessionId: "c1" });
    expect(oldGone.status).toBe(500);
  });

  test("undo_run rolls one turn back to its checkpoint", async () => {
    const { base, token } = await startDaemon();
    const send = {
      provider: "anthropic",
      model: "test-model",
      systemPrompt: "sys",
    };
    await rpcOk(base, token, "session_send", { ...send, sessionId: "u1", userText: "first" });
    await rpcOk(base, token, "session_send", { ...send, sessionId: "u1", userText: "second" });
    const before = (await rpcOk(base, token, "session_show", { sessionId: "u1" })) as { entries: unknown[] };
    expect(before.entries).toHaveLength(6);

    const undone = (await rpcOk(base, token, "undo_run", { sessionId: "u1" })) as { undone: boolean };
    expect(undone.undone).toBe(true);
    const after = (await rpcOk(base, token, "session_show", { sessionId: "u1" })) as {
      entries: unknown[];
      messages: unknown[];
    };
    expect(after.entries).toHaveLength(3);
    expect(after.messages).toHaveLength(2);

    const cost = (await rpcOk(base, token, "cost_report", { sessionId: "u1" })) as {
      sessions: { turns: number }[];
    };
    expect(cost.sessions[0]?.turns).toBe(1);
  });

  test("undo_run without a checkpoint reports not undone", async () => {
    const { base, token } = await startDaemon();
    const result = (await rpcOk(base, token, "undo_run", { sessionId: "never-sent" })) as { undone: boolean };
    expect(result.undone).toBe(false);
  });

  test("todo_write and todo_read round-trip with status validation", async () => {
    const { base, token } = await startDaemon();
    await rpcOk(base, token, "session_create", { sessionId: "t1" });
    const written = (await rpcOk(base, token, "todo_write", {
      sessionId: "t1",
      todos: [{ id: "a", content: "do it", status: "in_progress" }],
    })) as { written: number };
    expect(written.written).toBe(1);
    const read = (await rpcOk(base, token, "todo_read", { sessionId: "t1" })) as {
      todos: { id: string; content: string; status: string }[];
    };
    expect(read.todos).toEqual([{ id: "a", content: "do it", status: "in_progress" }]);
    const bad = await rpcCall(base, token, "todo_write", {
      sessionId: "t1",
      todos: [{ id: "b", content: "bad", status: "napping" }],
    });
    expect(bad.status).toBe(500);
  });

  test("config_get redacts secrets and config_set changes runtime keys only", async () => {
    const { base, token } = await startDaemon();
    const full = (await rpcOk(base, token, "config_get")) as { config: Record<string, unknown> };
    expect(full.config.logLevel).toBe("info");
    const one = (await rpcOk(base, token, "config_get", { key: "logLevel" })) as { value: string };
    expect(one.value).toBe("info");

    await rpcOk(base, token, "config_set", { key: "logLevel", value: "warn" });
    const changed = (await rpcOk(base, token, "config_get", { key: "logLevel" })) as { value: string };
    expect(changed.value).toBe("warn");

    const rejected = await rpcCall(base, token, "config_set", { key: "provider", value: {} });
    expect(rejected.status).toBe(500);
    const badValue = await rpcCall(base, token, "config_set", { key: "logLevel", value: "loud" });
    expect(badValue.status).toBe(500);
  });

  test("models_list, permissions_list, prompt_inspect, cost_report", async () => {
    const { base, token } = await startDaemon();
    const models = (await rpcOk(base, token, "models_list")) as { models: { id: string; family: string }[] };
    expect(models.models.length).toBeGreaterThan(0);
    const scoped = (await rpcOk(base, token, "models_list", { provider: "anthropic" })) as {
      models: { family: string }[];
    };
    expect(scoped.models.length).toBeGreaterThan(0);
    for (const m of scoped.models) expect(m.family).toBe("anthropic");

    const perms = (await rpcOk(base, token, "permissions_list")) as {
      permissions: unknown;
      capabilities: unknown;
    };
    expect(perms.permissions).toBeDefined();
    expect(perms.capabilities).toBeDefined();

    const inspected = (await rpcOk(base, token, "prompt_inspect", { systemPrompt: "hello-sys" })) as {
      prompt: string;
    };
    expect(inspected.prompt).toContain("hello-sys");

    await rpcOk(base, token, "session_send", {
      sessionId: "cost1",
      provider: "anthropic",
      model: "test-model",
      systemPrompt: "sys",
      userText: "hi",
    });
    const cost = (await rpcOk(base, token, "cost_report", { sessionId: "cost1" })) as {
      sessions: { turns: number; inputTokens: number; outputTokens: number }[];
      agents: unknown[];
      total: { turns: number };
    };
    expect(cost.sessions).toHaveLength(1);
    expect(cost.sessions[0]?.turns).toBe(1);
    expect(cost.sessions[0]?.inputTokens).toBe(5);
    expect(cost.sessions[0]?.outputTokens).toBe(5);
    expect(cost.total.turns).toBe(1);
    expect(Array.isArray(cost.agents)).toBe(true);
  });

  test("the state frame session matches a fresh session_show", async () => {
    const { base, token } = await startDaemon();
    await rpcOk(base, token, "session_send", {
      sessionId: "s1",
      provider: "anthropic",
      model: "test-model",
      systemPrompt: "sys",
      userText: "hello",
    });
    const shown = await rpcOk(base, token, "session_show", { sessionId: "s1" });
    const state = await readStateFrame(base, token, "s1");
    expect(state.session).toEqual(shown);
  });

  test("an approval outstanding across a reconnect appears in the state frame", async () => {
    const { base, token } = await startDaemon({
      adapter: toolCallingAdapter("fakebash", { command: "rm -rf build" }),
      tools: [dangerousTool],
    });
    const sendPromise = rpcOk(base, token, "session_send", {
      sessionId: "ask1",
      turnId: "ask-turn-1",
      provider: "anthropic",
      model: "test-model",
      systemPrompt: "sys",
      userText: "run it",
    });

    let requestId = "";
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline && requestId === "") {
      const state = await readStateFrame(base, token, "ask1");
      const approvals = state.approvals as { id: string; request: { tool: string } }[];
      const ask = approvals.find((a) => a.request.tool === "fakebash");
      if (ask) requestId = ask.id;
      else await new Promise((r) => setTimeout(r, 100));
    }
    expect(requestId).not.toBe("");

    await rpcOk(base, token, "approval_respond", {
      requestId,
      decision: "reject",
      sessionId: "ask1",
    });
    const result = (await sendPromise) as { stopReason: string };
    expect(result.stopReason).toBe("end_turn");
  }, 30_000);
});
