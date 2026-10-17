import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HttpClient } from "@agency/net";
import type { ProviderAdapter, StreamEvent } from "@agency/providers";
import { type AgentDaemon, createAgentDaemon } from "../src/daemon.ts";

const daemons: AgentDaemon[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const daemon of daemons.splice(0)) await daemon.stop();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const tempDir = (prefix: string) => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
};

const adapter: ProviderAdapter = {
  family: "fake",
  async *stream(): AsyncIterable<StreamEvent> {
    yield { type: "text_delta", text: "done" };
    yield { type: "message_stop", stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1 } };
  },
};

async function turnCassette(config: Record<string, unknown>): Promise<boolean> {
  const ws = tempDir("agency-cassette-ws-");
  const sessionsDir = tempDir("agency-cassette-sess-");
  const configDir = tempDir("agency-cassette-cfg-");
  writeFileSync(join(configDir, "config.jsonc"), JSON.stringify({ schemaVersion: 2, ...config }));
  const daemon = await createAgentDaemon({
    workspaceRoot: ws,
    instanceFile: join(ws, ".agency", "instance.json"),
    sessionsDir,
    approvalsDir: tempDir("agency-cassette-appr-"),
    configDir,
    adapterFor: () => adapter,
    http: { fetch: async () => new Response() } satisfies HttpClient,
  });
  daemons.push(daemon);
  const res = await fetch(`http://127.0.0.1:${daemon.httpPort}/rpc`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${daemon.server.token}` },
    body: JSON.stringify({
      id: 1,
      method: "run_turn",
      params: {
        turnId: "t1",
        sessionId: "s",
        provider: "anthropic",
        model: "m",
        apiKey: "k",
        systemPrompt: "sys",
        session: [],
      },
    }),
  });
  expect(((await res.json()) as { error?: unknown }).error).toBeUndefined();
  // Both files are written after the reply, without a wait.
  const cassette = join(sessionsDir, "s.t1.cassette.json");
  for (let i = 0; i < 40 && !(existsSync(join(sessionsDir, "s.trace.jsonl")) && existsSync(cassette)); i++)
    await Bun.sleep(50);
  expect(existsSync(join(sessionsDir, "s.trace.jsonl"))).toBe(true);
  return existsSync(cassette);
}

test("a turn writes no cassette by default: one holds the whole history and grows with the session", async () => {
  expect(await turnCassette({})).toBe(false);
});

test("trace.cassettes records each turn for /replay", async () => {
  expect(await turnCassette({ trace: { cassettes: true } })).toBe(true);
});
