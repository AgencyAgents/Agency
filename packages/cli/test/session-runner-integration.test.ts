import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore } from "@agency/core";
import type { HttpClient } from "@agency/net";
import type { ProviderAdapter, StreamEvent } from "@agency/providers";
import { createApproximateTokenizer } from "@agency/providers";
import { connectToDaemon, type DaemonClient } from "@agency/rpc";
import { type AgentDaemon, createAgentDaemon } from "../src/daemon.ts";
import { runSessionTurn } from "../src/session-runner.ts";

const noopHttp: HttpClient = { fetch: async () => new Response() };
const daemons: AgentDaemon[] = [];
const clients: DaemonClient[] = [];
const dirs: string[] = [];

// runSessionTurn no longer sends a key over the wire (A3): the daemon
// resolves it from env/keychain, so give it one to find.
const previousEnvKey = process.env.AGENCY_ANTHROPIC_API_KEY;
process.env.AGENCY_ANTHROPIC_API_KEY = "test-key-daemon-side";
afterAll(() => {
  if (previousEnvKey === undefined) delete process.env.AGENCY_ANTHROPIC_API_KEY;
  else process.env.AGENCY_ANTHROPIC_API_KEY = previousEnvKey;
});

afterEach(async () => {
  for (const client of clients.splice(0)) await client.close();
  for (const daemon of daemons.splice(0)) await daemon.stop();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

/** Replies with fixed text, ignoring the request, so tests can assert on
 *  what session-runner did around the call rather than a scripted model. */
function echoAdapter(reply = "ok"): ProviderAdapter {
  return {
    family: "fake",
    async *stream(): AsyncIterable<StreamEvent> {
      yield { type: "text_delta", text: reply };
      yield { type: "message_stop", stopReason: "end_turn", usage: { inputTokens: 5, outputTokens: 5 } };
    },
  };
}

async function connectedDaemon(workspaceRoot: string, adapter: ProviderAdapter) {
  const daemon = await createAgentDaemon({
    workspaceRoot,
    instanceFile: join(workspaceRoot, ".agency", "instance.json"),
    adapterFor: () => adapter,
    http: noopHttp,
    tools: [],
  });
  daemons.push(daemon);
  const client = await connectToDaemon(daemon.server.port, "127.0.0.1", { token: daemon.server.token });
  clients.push(client);
  return client;
}

describe("runSessionTurn", () => {
  test("persists each turn's messages, and a second turn sees the first as real history", async () => {
    const workspaceRoot = tempDir("agency-session-ws-");
    const sessionsDir = tempDir("agency-session-store-");
    const store = new SessionStore(sessionsDir);
    store.create("s1");
    const client = await connectedDaemon(workspaceRoot, echoAdapter("first reply"));

    await runSessionTurn(client, {
      store,
      sessionId: "s1",
      provider: "anthropic",
      model: "test-model",
      systemPrompt: "sys",
      userText: "hello",
    });

    const entries = store.load("s1");
    // user message + assistant reply, both persisted as their own entries
    expect(entries).toHaveLength(2);
    expect(entries[0]?.type).toBe("message");
    expect(entries[1]?.type).toBe("message");

    await runSessionTurn(client, {
      store,
      sessionId: "s1",
      provider: "anthropic",
      model: "test-model",
      systemPrompt: "sys",
      userText: "again",
    });

    expect(store.load("s1")).toHaveLength(4);
  });

  test("a fresh SessionStore over the same directory resumes exactly where a prior process left off", async () => {
    const workspaceRoot = tempDir("agency-session-ws-");
    const sessionsDir = tempDir("agency-session-store-");
    const firstProcessStore = new SessionStore(sessionsDir);
    firstProcessStore.create("s1");
    const client = await connectedDaemon(workspaceRoot, echoAdapter("reply"));

    await runSessionTurn(client, {
      store: firstProcessStore,
      sessionId: "s1",
      provider: "anthropic",
      model: "test-model",
      systemPrompt: "sys",
      userText: "before restart",
    });

    // Simulate the process restarting: a brand-new SessionStore instance,
    // same directory, no in-memory state carried over.
    const secondProcessStore = new SessionStore(sessionsDir);
    const entries = secondProcessStore.load("s1");
    const tip = secondProcessStore.latestTip(entries);
    expect(tip).toBeDefined();
    expect(secondProcessStore.messagesFor(entries, tip as string)).toHaveLength(2);
  });

  test("compaction runs before the turn and never drops a todo_state entry", async () => {
    const workspaceRoot = tempDir("agency-session-ws-");
    const sessionsDir = tempDir("agency-session-store-");
    const store = new SessionStore(sessionsDir);
    store.create("s1");
    const client = await connectedDaemon(workspaceRoot, echoAdapter("reply"));

    // Build up a session that's already over threshold before the next turn.
    let parentId: string | null = null;
    const append = async (entry: { type: string } & Record<string, unknown>) => {
      const e = await store.append("s1", { ...entry, parentId });
      parentId = e.id;
      return e;
    };
    await append({
      type: "message",
      message: { role: "user", content: [{ type: "text", text: "x".repeat(200) }] },
    });
    await append({ type: "todo_state", todos: [{ id: "t1", content: "ship P5", status: "in_progress" }] });
    await append({
      type: "message",
      message: { role: "assistant", content: [{ type: "text", text: "y".repeat(200) }] },
    });

    const summarizeCalls: string[] = [];
    await runSessionTurn(client, {
      store,
      sessionId: "s1",
      provider: "anthropic",
      model: "test-model",
      systemPrompt: "sys",
      userText: "continue",
      compaction: {
        tokenizer: createApproximateTokenizer(1),
        threshold: { contextWindow: 100, proactiveRatio: 0.5 },
        summarize: async (text) => {
          summarizeCalls.push(text);
          return "condensed history";
        },
      },
    });

    expect(summarizeCalls).toHaveLength(1);

    const entries = store.load("s1");
    const tip = store.latestTip(entries) as string;
    const chain = store.chainFor(entries, tip);
    expect(chain.some((e) => e.type === "todo_state")).toBe(true);
    expect(chain.some((e) => e.type === "compaction_summary")).toBe(true);
  });
});
