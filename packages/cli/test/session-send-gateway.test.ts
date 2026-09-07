import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HttpClient } from "@agency/net";
import type { ProviderAdapter, StreamEvent } from "@agency/providers";
import { AgencyError, ErrorCode } from "@agency/schema";
import { type AgentDaemon, createAgentDaemon } from "../src/daemon.ts";

const noopHttp: HttpClient = { fetch: async () => new Response() };
const daemons: AgentDaemon[] = [];
const dirs: string[] = [];

const prevKey = process.env.AGENCY_ANTHROPIC_API_KEY;
process.env.AGENCY_ANTHROPIC_API_KEY = "test-key-gateway";
afterAll(() => {
  if (prevKey === undefined) delete process.env.AGENCY_ANTHROPIC_API_KEY;
  else process.env.AGENCY_ANTHROPIC_API_KEY = prevKey;
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

function writeConfigDir(config: Record<string, unknown>): string {
  const dir = tempDir("agency-gw-config-");
  writeFileSync(join(dir, "config.jsonc"), JSON.stringify({ schemaVersion: 2, ...config }));
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

async function startDaemon(adapter: ProviderAdapter, opts: { configDir?: string; tools?: never[] } = {}) {
  const workspaceRoot = tempDir("agency-gw-ws-");
  const daemon = await createAgentDaemon({
    workspaceRoot,
    instanceFile: join(workspaceRoot, ".agency", "instance.json"),
    sessionsDir: tempDir("agency-gw-sess-"),
    adapterFor: () => adapter,
    http: noopHttp,
    tools: [],
    ...(opts.configDir ? { configDir: opts.configDir } : {}),
  });
  daemons.push(daemon);
  const base = `http://127.0.0.1:${daemon.httpPort}`;
  const token = daemon.server.token as string;
  return { daemon, base, token };
}

async function rpcCall(
  base: string,
  token: string,
  method: string,
  params: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const res = await fetch(`${base}/rpc`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ id: `req-${Math.random()}`, method, params }),
  });
  const body = (await res.json()) as { result?: Record<string, unknown>; error?: unknown };
  if (res.status !== 200 || body.error !== undefined || body.result === undefined) {
    throw new Error(`rpc ${method} failed: ${JSON.stringify(body)}`);
  }
  return body.result;
}

async function sessionSend(
  base: string,
  token: string,
  params: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  return rpcCall(base, token, "session_send", {
    provider: "anthropic",
    model: "test-model",
    systemPrompt: "sys",
    ...params,
  });
}

async function collectSseUntil(url: string, token: string, until: (acc: string) => boolean): Promise<string> {
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (res.status !== 200 || !res.body) throw new Error(`SSE subscribe failed: ${res.status}`);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let acc = "";
  const deadline = Date.now() + 15_000;
  try {
    while (Date.now() < deadline && !until(acc)) {
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
  if (!until(acc)) throw new Error(`SSE condition unmet; got: ${JSON.stringify(acc.slice(0, 500))}`);
  return acc;
}

describe("session_send over the HTTP gateway", () => {
  test("create, send, stream, and continue with no client-side session logic", async () => {
    const { base, token } = await startDaemon(echoAdapter("first"));

    // Unknown id is created daemon-side on first send.
    const first = await sessionSend(base, token, { sessionId: "gw-s1", userText: "hello" });
    expect(first.stopReason).toBe("end_turn");
    expect(typeof first.tipId).toBe("string");
    expect(first.compacted).toBe(false);
    expect(first.messages as unknown[]).toHaveLength(2);

    const shown = await rpcCall(base, token, "session_show", { sessionId: "gw-s1" });
    const types = (shown.entries as Array<{ type: string }>).map((e) => e.type);
    expect(types).toEqual(["message", "message", "usage"]);

    // Continuing sees the first turn as real history.
    const second = await sessionSend(base, token, { sessionId: "gw-s1", userText: "again" });
    expect(second.stopReason).toBe("end_turn");
    expect(second.messages as unknown[]).toHaveLength(4);
    const shown2 = await rpcCall(base, token, "session_show", { sessionId: "gw-s1" });
    expect(shown2.entries as unknown[]).toHaveLength(6);
  });

  test("turn events stream over the existing event stream", async () => {
    const { base, token } = await startDaemon(echoAdapter("streamed"));
    const turnId = "gw-stream-1";
    const sse = collectSseUntil(`${base}/events?stream=turn.${turnId}`, token, (acc) =>
      acc.includes("text_delta"),
    );
    await new Promise((r) => setTimeout(r, 200));
    const result = await sessionSend(base, token, { sessionId: "gw-sse", userText: "hi", turnId });
    expect(result.turnId).toBe(turnId);
    const acc = await sse;
    expect(acc).toContain("streamed");
  });

  test("proactive auto-compaction fires daemon-side as the window fills", async () => {
    const { base, token } = await startDaemon(echoAdapter("n"));
    for (let i = 0; i < 11; i++) {
      const r = await sessionSend(base, token, {
        sessionId: "gw-auto",
        userText: `fill ${i} ${"x".repeat(1200)}`,
      });
      expect(r.stopReason).toBe("end_turn");
    }
    const last = await sessionSend(base, token, {
      sessionId: "gw-auto",
      userText: "trigger",
      contextWindow: 3000,
    });
    expect(last.compacted).toBe(true);
    const shown = await rpcCall(base, token, "session_show", { sessionId: "gw-auto" });
    expect((shown.entries as Array<{ type: string }>).some((e) => e.type === "compaction_summary")).toBe(
      true,
    );
  }, 60000);

  test("reactive compact-and-retry recovers from provider overflow", async () => {
    let armed = false;
    let calls = 0;
    const adapter: ProviderAdapter = {
      family: "fake",
      async *stream(): AsyncIterable<StreamEvent> {
        calls += 1;
        if (armed) {
          armed = false;
          throw new AgencyError(ErrorCode.CONTEXT_OVERFLOW, "prompt is too long", { source: "fake" });
        }
        yield { type: "text_delta", text: "recovered" };
        yield { type: "message_stop", stopReason: "end_turn", usage: { inputTokens: 5, outputTokens: 5 } };
      },
    };
    const { base, token } = await startDaemon(adapter);
    for (let i = 0; i < 3; i++) {
      await sessionSend(base, token, { sessionId: "gw-overflow", userText: `seed ${i} ${"x".repeat(400)}` });
    }
    armed = true;
    const result = await sessionSend(base, token, { sessionId: "gw-overflow", userText: "after overflow" });
    expect(result.stopReason).toBe("end_turn");
    expect(calls).toBeGreaterThanOrEqual(5);
    const shown = await rpcCall(base, token, "session_show", { sessionId: "gw-overflow" });
    expect((shown.entries as Array<{ type: string }>).some((e) => e.type === "compaction_summary")).toBe(
      true,
    );
  });

  test("concurrent sends serialize: exactly one writer, every parent resolves", async () => {
    const { base, token } = await startDaemon(echoAdapter("ok"));
    const sends = await Promise.all(
      [0, 1, 2, 3, 4].map((i) => sessionSend(base, token, { sessionId: "gw-race", userText: `msg ${i}` })),
    );
    for (const r of sends) expect(r.stopReason).toBe("end_turn");
    const shown = await rpcCall(base, token, "session_show", { sessionId: "gw-race" });
    const entries = shown.entries as Array<{ id: string; parentId: string | null; type: string }>;
    expect(entries).toHaveLength(15);
    const ids = new Set(entries.map((e) => e.id));
    for (const e of entries) {
      if (e.parentId !== null) expect(ids.has(e.parentId)).toBe(true);
    }
  });

  test("@handle text routes provider, model, and effort through session_send", async () => {
    const models: string[] = [];
    const adapter: ProviderAdapter = {
      family: "fake",
      async *stream(request): AsyncIterable<StreamEvent> {
        models.push(request.model);
        yield { type: "text_delta", text: "routed" };
        yield { type: "message_stop", stopReason: "end_turn", usage: { inputTokens: 5, outputTokens: 5 } };
      },
    };
    const configDir = writeConfigDir({
      agents: {
        leader: {
          role: "lead",
          provider: "anthropic",
          model: "leader-model",
          effort: "medium",
          enabled: true,
        },
        coder: {
          role: "coder",
          provider: "anthropic",
          model: "coder-model",
          effort: "medium",
          enabled: true,
        },
      },
    });
    const { base, token } = await startDaemon(adapter, { configDir });
    await sessionSend(base, token, { sessionId: "gw-route", userText: "@coder fix the build" });
    expect(models.at(-1)).toBe("coder-model");
    await sessionSend(base, token, { sessionId: "gw-route", userText: "plain question" });
    expect(models.at(-1)).toBe("test-model");
  });
});
