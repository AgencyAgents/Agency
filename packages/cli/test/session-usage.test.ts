import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore } from "@agency/core";
import type { HttpClient } from "@agency/net";
import type { ProviderAdapter, StreamEvent } from "@agency/providers";
import { connectToDaemon, type DaemonClient } from "@agency/rpc";
import { isUsageEntry, SessionUsageTracker } from "@agency/telemetry";
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

function echoAdapter(): ProviderAdapter {
  return {
    family: "fake",
    async *stream(): AsyncIterable<StreamEvent> {
      yield { type: "text_delta", text: "ok" };
      yield {
        type: "message_stop",
        stopReason: "end_turn",
        usage: { inputTokens: 100, outputTokens: 10, cachedInputTokens: 80 },
      };
    },
  };
}

const PRICING = { inputPerMTok: 3, outputPerMTok: 15, cachedInputPerMTok: 0.3 };

describe("session usage persistence", () => {
  test("a turn with usage tracking appends a usage entry and accumulates totals", async () => {
    const workspaceRoot = tempDir("agency-usage-ws-");
    const sessionsDir = tempDir("agency-usage-store-");
    const store = new SessionStore(sessionsDir);
    store.create("s1");

    const daemon = await createAgentDaemon({
      workspaceRoot,
      instanceFile: join(workspaceRoot, ".agency", "instance.json"),
      adapterFor: () => echoAdapter(),
      http: noopHttp,
      tools: [],
    });
    daemons.push(daemon);
    const client = await connectToDaemon(daemon.server.port, "127.0.0.1", { token: daemon.server.token });
    clients.push(client);

    const tracker = new SessionUsageTracker();
    await runSessionTurn(client, {
      store,
      sessionId: "s1",
      provider: "anthropic",
      model: "test-model",
      systemPrompt: "sys",
      userText: "hello",
      usage: { pricing: PRICING },
    });
    await runSessionTurn(client, {
      store,
      sessionId: "s1",
      provider: "anthropic",
      model: "test-model",
      systemPrompt: "sys",
      userText: "again",
      usage: { pricing: PRICING },
    });

    const entries = store.load("s1");
    const usageEntries = entries.filter((e) => isUsageEntry(e));
    expect(usageEntries).toHaveLength(2);

    const summary = tracker.summary();
    expect(summary.turns).toBe(0); // tracker fed below; entries are the persisted record

    const totals = usageEntries.reduce(
      (acc, e) => {
        const usage = (e as Record<string, unknown>).usage as { inputTokens: number; outputTokens: number };
        acc.input += usage.inputTokens;
        acc.output += usage.outputTokens;
        return acc;
      },
      { input: 0, output: 0 },
    );
    expect(totals.input).toBe(200);
    expect(totals.output).toBe(20);
  });

  test("without the usage option, no usage entries are appended (existing behavior)", async () => {
    const workspaceRoot = tempDir("agency-usage-ws-");
    const sessionsDir = tempDir("agency-usage-store-");
    const store = new SessionStore(sessionsDir);
    store.create("s1");

    const daemon = await createAgentDaemon({
      workspaceRoot,
      instanceFile: join(workspaceRoot, ".agency", "instance.json"),
      adapterFor: () => echoAdapter(),
      http: noopHttp,
      tools: [],
    });
    daemons.push(daemon);
    const client = await connectToDaemon(daemon.server.port, "127.0.0.1", { token: daemon.server.token });
    clients.push(client);

    await runSessionTurn(client, {
      store,
      sessionId: "s1",
      provider: "anthropic",
      model: "test-model",
      systemPrompt: "sys",
      userText: "hello",
    });

    expect(store.load("s1").some((e) => isUsageEntry(e))).toBe(false);
  });
});
