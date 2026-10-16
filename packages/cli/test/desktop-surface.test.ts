import { afterAll, afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HttpClient } from "@agency/net";
import type { ProviderAdapter, ProviderRequest, StreamEvent } from "@agency/providers";
import { hashWorkspaceRoot } from "@agency/rpc";
import { type AgentDaemon, createAgentDaemon, DEFAULT_SYSTEM_PROMPT } from "../src/daemon.ts";
import { runEntrypoint } from "../src/entrypoint.ts";

const noopHttp: HttpClient = { fetch: async () => new Response() };
const daemons: AgentDaemon[] = [];
const dirs: string[] = [];

const prevKey = process.env.AGENCY_ANTHROPIC_API_KEY;
process.env.AGENCY_ANTHROPIC_API_KEY = "test-key-desktop";
afterAll(() => {
  if (prevKey === undefined) delete process.env.AGENCY_ANTHROPIC_API_KEY;
  else process.env.AGENCY_ANTHROPIC_API_KEY = prevKey;
});

afterEach(async () => {
  for (const daemon of daemons.splice(0)) await daemon.stop();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tmp(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), `agency-desktop-${name}-`));
  dirs.push(dir);
  return dir;
}

const seen: ProviderRequest[] = [];
const adapter: ProviderAdapter = {
  family: "fake",
  async *stream(request): AsyncIterable<StreamEvent> {
    seen.push(request);
    yield { type: "text_delta", text: "ok" };
    yield { type: "message_stop", stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1 } };
  },
};

async function start(extra: { idleLingerMs?: number; onIdleShutdown?: () => void } = {}) {
  const workspaceRoot = tmp("ws");
  const instanceDir = tmp("instances");
  const instanceFile = join(instanceDir, `${hashWorkspaceRoot(workspaceRoot)}.json`);
  const daemon = await createAgentDaemon({
    workspaceRoot,
    instanceFile,
    sessionsDir: tmp("sess"),
    approvalsDir: tmp("approvals"),
    adapterFor: () => adapter,
    http: noopHttp,
    tools: [],
    ...(extra.idleLingerMs === undefined ? {} : { idleLingerMs: extra.idleLingerMs, idleFromStart: true }),
    ...(extra.onIdleShutdown ? { onIdleShutdown: extra.onIdleShutdown } : {}),
  });
  daemons.push(daemon);
  return { daemon, workspaceRoot, instanceDir, instanceFile, base: `http://127.0.0.1:${daemon.httpPort}` };
}

test("daemon start --format json names the running daemon and its instance file", async () => {
  const { daemon, workspaceRoot, instanceDir, instanceFile } = await start();
  const out: string[] = [];
  const code = await runEntrypoint(["daemon", "start", "--format", "json", "--workspace", workspaceRoot], {
    out: (line) => {
      out.push(line);
    },
    err: () => {},
    instanceDir,
  });

  expect(code).toBe(0);
  const printed = JSON.parse(out.join("\n")) as Record<string, unknown>;
  expect(printed).toEqual({
    status: "running",
    port: daemon.server.port,
    httpPort: daemon.httpPort,
    pid: process.pid,
    instanceFile,
  });
  expect(out.join("\n")).not.toContain(daemon.server.token as string);
});

test("session_send with no systemPrompt runs on the default prompt", async () => {
  const { daemon, base } = await start();
  seen.length = 0;
  const res = await fetch(`${base}/rpc`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${daemon.server.token}` },
    body: JSON.stringify({
      id: 1,
      method: "session_send",
      params: { sessionId: "s1", provider: "anthropic", model: "test-model", userText: "hi" },
    }),
  });

  expect(res.status).toBe(200);
  expect(seen.at(-1)?.system).toContain(DEFAULT_SYSTEM_PROMPT.split("\n")[0] as string);
});

test("an SSE subscriber keeps an idle daemon up, and its leaving starts the linger", async () => {
  let shutdowns = 0;
  const { daemon, base } = await start({ idleLingerMs: 150, onIdleShutdown: () => shutdowns++ });
  const controller = new AbortController();
  const res = await fetch(`${base}/events`, {
    headers: { Authorization: `Bearer ${daemon.server.token}` },
    signal: controller.signal,
  });
  await (res.body as ReadableStream<Uint8Array>).getReader().read();

  await Bun.sleep(400);
  expect(shutdowns).toBe(0);

  controller.abort();
  await Bun.sleep(600);
  expect(shutdowns).toBe(1);
});
