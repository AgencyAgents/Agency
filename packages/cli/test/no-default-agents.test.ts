import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFileTrustStore } from "@agency/guard";
import type { HttpClient } from "@agency/net";
import type { ProviderAdapter, StreamEvent } from "@agency/providers";
import { buildDispatchTool } from "../src/daemon/handlers/dispatch.ts";
import type { DaemonContext } from "../src/daemon/types.ts";
import { type AgentDaemon, createAgentDaemon } from "../src/daemon.ts";

const noopHttp: HttpClient = { fetch: async () => new Response() };
const daemons: AgentDaemon[] = [];
const dirs: string[] = [];

const prevKey = process.env.AGENCY_ANTHROPIC_API_KEY;
process.env.AGENCY_ANTHROPIC_API_KEY = "test-key-no-agents";
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

const echoAdapter: ProviderAdapter = {
  family: "fake",
  async *stream(): AsyncIterable<StreamEvent> {
    yield { type: "text_delta", text: "ok" };
    yield { type: "message_stop", stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1 } };
  },
};

async function startTrustedDaemon() {
  const ws = tempDir("agency-noagents-ws-");
  const trustStorePath = join(tempDir("agency-noagents-trust-"), "trust.json");
  createFileTrustStore(trustStorePath).trust(ws);
  const daemon = await createAgentDaemon({
    workspaceRoot: ws,
    configDir: tempDir("agency-noagents-cfg-"),
    instanceFile: join(ws, ".agency", "instance.json"),
    sessionsDir: tempDir("agency-noagents-sess-"),
    approvalsDir: tempDir("agency-noagents-appr-"),
    trustStorePath,
    adapterFor: () => echoAdapter,
    http: noopHttp,
    tools: [],
  });
  daemons.push(daemon);
  const base = `http://127.0.0.1:${daemon.httpPort}`;
  const token = daemon.server.token as string;
  const rpc = async (method: string, params: Record<string, unknown> = {}) => {
    const res = await fetch(`${base}/rpc`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ id: `req-${method}`, method, params }),
    });
    return (await res.json()) as { result?: unknown; error?: { message: string } };
  };
  return { ws, rpc };
}

describe("no built-in agents", () => {
  test("daemon start in a trusted workspace seeds no agents and writes no agent files", async () => {
    const { ws, rpc } = await startTrustedDaemon();
    expect(existsSync(join(ws, ".agency", "agents"))).toBe(false);
    const cfg = (await rpc("config_get")).result as { config: { agents?: Record<string, unknown> } };
    expect(Object.keys(cfg.config.agents ?? {})).toEqual([]);
    const list = (await rpc("agents_list")).result as unknown[];
    expect(list).toEqual([]);
  }, 30000);

  test("team_open and dispatch_compare with no agents fail with the add-an-agent message", async () => {
    const { rpc } = await startTrustedDaemon();
    const compare = await rpc("dispatch_compare", { handles: ["coder"], prompt: "go" });
    expect(compare.error?.message).toContain("add one under `agents` in config");
    const open = await rpc("team_open", {
      goal: "g",
      items: [{ content: "a" }, { content: "b" }],
      explicitRequest: true,
    });
    expect(open.error?.message).toContain(".agency/agents/<name>.md");
  }, 30000);

  test("the dispatch tool with no agents returns the add-an-agent error", async () => {
    const tool = buildDispatchTool({ teamRegistry: { list: () => [] } } as unknown as DaemonContext, "s1");
    const out = await tool.handler({ agents: [{ handle: "coder", brief: "go" }] }, {} as never);
    expect(out.isError).toBe(true);
    expect(out.content).toContain(".agency/agents/<name>.md");
  });
});
