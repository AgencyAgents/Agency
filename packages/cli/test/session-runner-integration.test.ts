import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore } from "@agency/core";
import type { HttpClient } from "@agency/net";
import type { ProviderAdapter, StreamEvent } from "@agency/providers";
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
 *  what session_send did around the call rather than a scripted model. */
function echoAdapter(reply = "ok"): ProviderAdapter {
  return {
    family: "fake",
    async *stream(): AsyncIterable<StreamEvent> {
      yield { type: "text_delta", text: reply };
      yield { type: "message_stop", stopReason: "end_turn", usage: { inputTokens: 5, outputTokens: 5 } };
    },
  };
}

async function connectedDaemon(workspaceRoot: string, adapter: ProviderAdapter, sessionsDir: string) {
  const daemon = await createAgentDaemon({
    workspaceRoot,
    instanceFile: join(workspaceRoot, ".agency", "instance.json"),
    sessionsDir,
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
  test("persists each turn's messages daemon-side, and a second turn sees the first as history", async () => {
    const workspaceRoot = tempDir("agency-session-ws-");
    const sessionsDir = tempDir("agency-session-store-");
    const client = await connectedDaemon(workspaceRoot, echoAdapter("first reply"), sessionsDir);

    await runSessionTurn(client, {
      sessionId: "s1",
      provider: "anthropic",
      model: "test-model",
      systemPrompt: "sys",
      userText: "hello",
    });

    const entries = new SessionStore(sessionsDir).load("s1");
    // user message + assistant reply + usage, all appended by the daemon
    expect(entries.map((e) => e.type)).toEqual(["message", "message", "usage"]);

    await runSessionTurn(client, {
      sessionId: "s1",
      provider: "anthropic",
      model: "test-model",
      systemPrompt: "sys",
      userText: "again",
    });

    expect(new SessionStore(sessionsDir).load("s1")).toHaveLength(6);
  });

  test("a session_send for an unknown id creates the session daemon-side", async () => {
    const workspaceRoot = tempDir("agency-session-ws-");
    const sessionsDir = tempDir("agency-session-store-");
    const client = await connectedDaemon(workspaceRoot, echoAdapter("reply"), sessionsDir);

    const { tipId } = await runSessionTurn(client, {
      sessionId: "fresh",
      provider: "anthropic",
      model: "test-model",
      systemPrompt: "sys",
      userText: "before restart",
    });
    expect(typeof tipId).toBe("string");

    const store = new SessionStore(sessionsDir);
    const entries = store.load("fresh");
    const tip = store.latestTip(entries);
    expect(tip).toBeDefined();
    expect(store.messagesFor(entries, tip as string)).toHaveLength(2);
  });

  test("session_show projects the turn through the wired SessionProjector", async () => {
    const workspaceRoot = tempDir("agency-session-ws-");
    const sessionsDir = tempDir("agency-session-store-");
    const client = await connectedDaemon(workspaceRoot, echoAdapter("reply"), sessionsDir);

    await runSessionTurn(client, {
      sessionId: "s1",
      provider: "anthropic",
      model: "test-model",
      systemPrompt: "sys",
      userText: "hello",
    });

    const shown = (await client.call("session_show", { sessionId: "s1" })) as {
      projection: Array<{ type: string }>;
    };
    const kinds = shown.projection.map((e) => e.type);
    expect(kinds).toContain("Created");
    expect(kinds).toContain("Updated");
  });

  test("proactive compaction fires daemon-side when the session approaches the window", async () => {
    const workspaceRoot = tempDir("agency-session-ws-");
    const sessionsDir = tempDir("agency-session-store-");
    const seed = new SessionStore(sessionsDir);
    seed.create("s1");

    // 8 x ~1k chars: over the 0.9 trigger of a 2k window, with more than
    // keepLastN (4) messages, so there is something to summarize.
    let parentId: string | null = null;
    for (let i = 0; i < 8; i++) {
      const e = await seed.append("s1", {
        type: "message",
        parentId,
        message: { role: "user", content: [{ type: "text", text: `turn ${i}: ${"x".repeat(1000)}` }] },
      });
      parentId = e.id;
    }
    const client = await connectedDaemon(workspaceRoot, echoAdapter("reply"), sessionsDir);

    const { result } = await runSessionTurn(client, {
      sessionId: "s1",
      provider: "anthropic",
      model: "test-model",
      systemPrompt: "sys",
      userText: "continue",
      contextWindow: 2000,
    });
    expect(result.stopReason).toBe("end_turn");

    const entries = new SessionStore(sessionsDir).load("s1");
    expect(entries.some((e) => e.type === "compaction_summary")).toBe(true);
  });
});
