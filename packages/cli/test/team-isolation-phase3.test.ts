import { afterEach, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HttpClient } from "@agency/net";
import type { ProviderAdapter, StreamEvent } from "@agency/providers";
import { connectToDaemon, type DaemonClient } from "@agency/rpc";
import { type AgentDaemon, createAgentDaemon, type RunTurnRpcResult } from "../src/daemon.ts";

const noopHttp: HttpClient = { fetch: async () => new Response() };
const daemons: AgentDaemon[] = [];
const clients: DaemonClient[] = [];
const dirs: string[] = [];

afterEach(async () => {
  for (const c of clients.splice(0)) await c.close().catch(() => {});
  for (const d of daemons.splice(0)) await d.stop().catch(() => {});
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

function writeConfigDir(config: Record<string, unknown>): string {
  const dir = tempDir("agency-iso3-cfg-");
  writeFileSync(join(dir, "config.jsonc"), JSON.stringify({ schemaVersion: 2, ...config }));
  return dir;
}

function gitRepo(): string {
  const root = tempDir("agency-iso3-root-");
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["config", "user.email", "qa@example.com"], { cwd: root });
  execFileSync("git", ["config", "user.name", "qa"], { cwd: root });
  writeFileSync(join(root, "app.ts"), "export const v = 1;\n");
  execFileSync("git", ["add", "."], { cwd: root });
  execFileSync("git", ["commit", "-qm", "init"], { cwd: root });
  return root;
}

const PRICED_MODEL = "claude-sonnet-5";
const USAGE = { inputTokens: 1000, outputTokens: 500 };

function teamCfg(): Record<string, unknown> {
  return {
    agents: {
      leader: {
        role: "GeneralDispatcher",
        provider: "anthropic",
        model: PRICED_MODEL,
        effort: "low",
        enabled: true,
      },
      w1: { role: "Worker", provider: "anthropic", model: PRICED_MODEL, effort: "low", enabled: true },
    },
  };
}

function parentChildAdapter(): ProviderAdapter {
  return {
    family: "fake",
    async *stream(request): AsyncIterable<StreamEvent> {
      const msgs = request.messages;
      const hasToolResult = msgs.some((m) =>
        m.content.some((b) => (b as { type: string }).type === "tool_result"),
      );
      const lastUser = [...msgs].reverse().find((m) => m.role === "user");
      const txt =
        (
          lastUser?.content.find((b) => (b as { type: string }).type === "text") as
            | { text?: string }
            | undefined
        )?.text ?? "";
      const parent = /^please dispatch ([AB])$/.exec(txt)?.[1];
      if (!hasToolResult && parent) {
        yield { type: "tool_call_start", id: "c1", name: "dispatch" };
        yield {
          type: "tool_call_delta",
          id: "c1",
          inputJsonDelta: JSON.stringify({ agents: [{ handle: "w1", brief: `brief for ${parent}` }] }),
        };
        yield { type: "tool_call_end", id: "c1" };
        yield { type: "message_stop", stopReason: "tool_use", usage: { ...USAGE } };
        return;
      }
      const texts = msgs
        .filter((m) => m.role === "user")
        .flatMap((m) => m.content)
        .filter((b) => (b as { type: string }).type === "text")
        .map((b) => (b as { text?: string }).text ?? "");
      yield { type: "text_delta", text: `seen:${texts.join("|")}` };
      yield { type: "message_stop", stopReason: "end_turn", usage: { ...USAGE } };
    },
  };
}

function dispatchAdapter(): ProviderAdapter {
  return {
    family: "fake",
    async *stream(request): AsyncIterable<StreamEvent> {
      const msgs = request.messages;
      const hasToolResult = msgs.some((m) =>
        m.content.some((b) => (b as { type: string }).type === "tool_result"),
      );
      const lastUser = [...msgs].reverse().find((m) => m.role === "user");
      const txt =
        (
          lastUser?.content.find((b) => (b as { type: string }).type === "text") as
            | { text?: string }
            | undefined
        )?.text ?? "";
      if (!hasToolResult && txt === "please dispatch") {
        yield { type: "tool_call_start", id: "c1", name: "dispatch" };
        yield {
          type: "tool_call_delta",
          id: "c1",
          inputJsonDelta: JSON.stringify({ agents: [{ handle: "w1", brief: "brief one" }] }),
        };
        yield { type: "tool_call_end", id: "c1" };
        yield { type: "message_stop", stopReason: "tool_use", usage: { ...USAGE } };
        return;
      }
      yield { type: "text_delta", text: "parent done" };
      yield { type: "message_stop", stopReason: "end_turn", usage: { ...USAGE } };
    },
  };
}

async function startDaemon(opts: { root: string; adapter: ProviderAdapter }) {
  const sessionsDir = tempDir("agency-iso3-sess-");
  const daemon = await createAgentDaemon({
    workspaceRoot: opts.root,
    instanceFile: join(tempDir("agency-iso3-inst-"), "instance.json"),
    adapterFor: () => opts.adapter,
    http: noopHttp,
    configDir: writeConfigDir(teamCfg()),
    sessionsDir,
  });
  daemons.push(daemon);
  const client = await connectToDaemon(daemon.server.port, "127.0.0.1", { token: daemon.server.token });
  clients.push(client);
  return { daemon, client, sessionsDir, root: opts.root };
}

function toolResultText(result: RunTurnRpcResult): string {
  const msg = result.messages.find(
    (m) => m.role === "user" && m.content.some((b) => b.type === "tool_result"),
  );
  const block = msg?.content.find((b) => b.type === "tool_result") as { content?: string } | undefined;
  return block?.content ?? "";
}

describe("team isolation (phase 3)", () => {
  it("same handle from two parents concurrently stays isolated", async () => {
    const { client, sessionsDir, root } = await startDaemon({
      root: gitRepo(),
      adapter: parentChildAdapter(),
    });

    async function runParent(parent: "A" | "B"): Promise<string> {
      const result = (await client.call("run_turn", {
        turnId: `iso3-${parent}-${Date.now()}`,
        provider: "anthropic",
        model: PRICED_MODEL,
        apiKey: "key",
        systemPrompt: "sys",
        session: [{ role: "user", content: [{ type: "text", text: `please dispatch ${parent}` }] }],
        sessionId: `parent-${parent}`,
      })) as RunTurnRpcResult;
      return toolResultText(result);
    }

    const [textA, textB] = await Promise.all([runParent("A"), runParent("B")]);
    expect(textA).toContain("brief for A");
    expect(textA).not.toContain("brief for B");
    expect(textB).toContain("brief for B");
    expect(textB).not.toContain("brief for A");

    const listA = (await client.call("agents_list", { sessionId: "parent-A" })) as Array<{
      handle: string;
      sessionId: string;
    }>;
    const listB = (await client.call("agents_list", { sessionId: "parent-B" })) as Array<{
      handle: string;
      sessionId: string;
    }>;
    const sidA = listA.find((a) => a.handle === "w1")!.sessionId;
    const sidB = listB.find((a) => a.handle === "w1")!.sessionId;
    expect(sidA).toBe("team-parent-A-w1-b0");
    expect(sidB).toBe("team-parent-B-w1-b0");
    expect(sidA).not.toBe(sidB);

    expect(existsSync(join(sessionsDir, `${sidA}.jsonl`))).toBe(true);
    expect(existsSync(join(sessionsDir, `${sidB}.jsonl`))).toBe(true);

    expect(existsSync(join(root, ".agency", "worktrees", "parent-A", "w1"))).toBe(true);
    expect(existsSync(join(root, ".agency", "worktrees", "parent-B", "w1"))).toBe(true);

    const statusA = (await client.call("team_status", { sessionId: "parent-A" })) as {
      costTotal: number;
    };
    const statusB = (await client.call("team_status", { sessionId: "parent-B" })) as {
      costTotal: number;
    };
    expect(statusA.costTotal).toBeGreaterThan(0);
    expect(statusB.costTotal).toBeGreaterThan(0);
    const statusAll = (await client.call("team_status", {})) as { costTotal: number };
    expect(statusAll.costTotal).toBeCloseTo(statusA.costTotal + statusB.costTotal);

    await client.call("agent_message", {
      from: "tester",
      to: "w1",
      body: "secret-for-A",
      sessionId: "parent-A",
    });
    const [againA, againB] = await Promise.all([runParent("A"), runParent("B")]);
    expect(againA).toContain("secret-for-A");
    expect(againB).not.toContain("secret-for-A");
  }, 60000);

  it("worktree failure aborts the peer instead of touching the workspace root", async () => {
    const root = tempDir("agency-iso3-nogit-");
    const { client, sessionsDir } = await startDaemon({ root, adapter: dispatchAdapter() });

    const result = (await client.call("run_turn", {
      turnId: "iso3-parent",
      provider: "anthropic",
      model: PRICED_MODEL,
      apiKey: "key",
      systemPrompt: "sys",
      session: [{ role: "user", content: [{ type: "text", text: "please dispatch" }] }],
      sessionId: "iso3-fail-parent",
    })) as RunTurnRpcResult;
    const text = toolResultText(result);
    expect(text).toContain("worktree creation failed for w1");
    expect(text).not.toContain("dispatched at");

    const agents = (await client.call("agents_list", { sessionId: "iso3-fail-parent" })) as Array<{
      handle: string;
      state: string;
      sessionId: string;
    }>;
    const w1 = agents.find((a) => a.handle === "w1")!;
    expect(w1.state).toBe("failed");
    expect(w1.sessionId).toBe("team-iso3-fail-parent-w1-b0");

    const childFile = readFileSync(join(sessionsDir, `${w1.sessionId}.jsonl`), "utf8");
    expect(childFile).toContain("agent_lifecycle");
    expect(childFile).toContain("failed");
    expect(childFile).not.toContain("task_result");

    expect(existsSync(join(root, ".agency", "worktrees", "iso3-fail-parent", "w1"))).toBe(false);
  }, 60000);
});
