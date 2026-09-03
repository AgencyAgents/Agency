import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore } from "@agency/core";
import type { HttpClient } from "@agency/net";
import type { ProviderAdapter, StreamEvent } from "@agency/providers";
import { createApproximateTokenizer } from "@agency/providers";
import { AgencyError, ErrorCode } from "@agency/schema";
import { connectToDaemon, type DaemonClient } from "@agency/rpc";
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

async function daemon(ws: string, adapter: ProviderAdapter) {
  const d = await createAgentDaemon({ workspaceRoot: ws, instanceFile: join(ws, ".agency", "instance.json"), adapterFor: () => adapter, http: noopHttp, tools: [] });
  daemons.push(d);
  const c = await connectToDaemon(d.server.port, "127.0.0.1", { token: d.server.token });
  clients.push(c);
  return c;
}

describe("compact-and-retry branch", () => {
  test("session exceeding window triggers compaction and turn continues (needsCompaction path)", async () => {
    const ws = tmp("agency-compact-ws-");
    const sessions = tmp("agency-compact-sess-");
    const store = new SessionStore(sessions);
    store.create("s1");

    let parent: string | null = null;
    for (let i = 0; i < 6; i++) {
      const e = await store.append("s1", { type: "message", parentId: parent, message: { role: "user", content: [{ type: "text", text: `history ${i} ${"x".repeat(800)}` }] } });
      parent = e.id;
    }

    const client = await daemon(ws, compactingAdapter());

    const { result, tipId } = await runSessionTurn(client, {
      store,
      sessionId: "s1",
      provider: "anthropic",
      model: "test-model",
      systemPrompt: "sys",
      userText: "continue after overflow",
      compaction: {
        tokenizer: createApproximateTokenizer(1),
        threshold: { contextWindow: 200, proactiveRatio: 0.5 },
        summarize: async (text) => `summary:${text.slice(0, 80)}`,
      },
    });

    expect(result.stopReason).toBe("end_turn");
    expect(result.messages.some((m) => JSON.stringify(m.content).includes("recovered after compaction"))).toBe(true);

    const entries = store.load("s1");
    const chain = store.chainFor(entries, tipId);
    expect(chain.some((e) => e.type === "compaction_summary")).toBe(true);
    expect(chain.some((e) => e.type === "message" && JSON.stringify(e).includes("continue after overflow"))).toBe(true);
  }, 15000);

  test("retry events: scheduler onRetry flows to LoopEvent retry event via runSessionTurn", async () => {
    const ws = tmp("agency-retry-ws-");
    const sessions = tmp("agency-retry-sess-");
    const store = new SessionStore(sessions);
    store.create("s2");
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
    const client = await daemon(ws, adapter);
    const events: unknown[] = [];
    const { result } = await runSessionTurn(client, {
      store,
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
