import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore } from "@agency/core";
import type { HttpClient } from "@agency/net";
import type { ProviderAdapter, StreamEvent } from "@agency/providers";
import { connectToDaemon, type DaemonClient } from "@agency/rpc";
import { isUsageEntry } from "@agency/telemetry";
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

async function connectedDaemon(workspaceRoot: string, sessionsDir: string) {
  const daemon = await createAgentDaemon({
    workspaceRoot,
    instanceFile: join(workspaceRoot, ".agency", "instance.json"),
    sessionsDir,
    adapterFor: () => echoAdapter(),
    http: noopHttp,
    tools: [],
  });
  daemons.push(daemon);
  const client = await connectToDaemon(daemon.server.port, "127.0.0.1", { token: daemon.server.token });
  clients.push(client);
  return client;
}

describe("session usage persistence", () => {
  test("session_send appends one usage entry per turn with the reported totals", async () => {
    const workspaceRoot = tempDir("agency-usage-ws-");
    const sessionsDir = tempDir("agency-usage-store-");
    const client = await connectedDaemon(workspaceRoot, sessionsDir);

    await runSessionTurn(client, {
      sessionId: "s1",
      provider: "anthropic",
      model: "test-model",
      systemPrompt: "sys",
      userText: "hello",
    });
    await runSessionTurn(client, {
      sessionId: "s1",
      provider: "anthropic",
      model: "test-model",
      systemPrompt: "sys",
      userText: "again",
    });

    const entries = new SessionStore(sessionsDir).load("s1");
    const usageEntries = entries.filter((e) => isUsageEntry(e));
    expect(usageEntries).toHaveLength(2);

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

  test("the usage entry records cache hit rate from the reported cached tokens", async () => {
    const workspaceRoot = tempDir("agency-usage-ws-");
    const sessionsDir = tempDir("agency-usage-store-");
    const client = await connectedDaemon(workspaceRoot, sessionsDir);

    await runSessionTurn(client, {
      sessionId: "s1",
      provider: "anthropic",
      model: "test-model",
      systemPrompt: "sys",
      userText: "hello",
    });

    const entries = new SessionStore(sessionsDir).load("s1");
    const usage = entries.find((e) => isUsageEntry(e)) as Record<string, unknown> | undefined;
    if (usage === undefined) throw new Error("expected a usage entry");
    expect((usage.usage as { cachedInputTokens?: number }).cachedInputTokens).toBe(80);
    expect(usage.cacheHitRate).toBeCloseTo(0.8);
  });
});
