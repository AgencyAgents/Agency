import { afterEach, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
  const dir = tempDir("agency-dh35-cfg-");
  writeFileSync(join(dir, "config.jsonc"), JSON.stringify({ schemaVersion: 2, ...config }));
  return dir;
}

const PRICED_MODEL = "claude-sonnet-5";

function teamCfg(extra?: Record<string, unknown>) {
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
      w2: { role: "Worker", provider: "anthropic", model: PRICED_MODEL, effort: "low", enabled: true },
    },
    ...(extra ?? {}),
  };
}

const USAGE = { inputTokens: 1000, outputTokens: 500 };

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
          inputJsonDelta: JSON.stringify({
            agents: [
              { handle: "w1", brief: "brief one" },
              { handle: "w2", brief: "brief two" },
            ],
          }),
        };
        yield { type: "tool_call_end", id: "c1" };
        yield { type: "message_stop", stopReason: "tool_use", usage: { ...USAGE } };
        return;
      }
      if (txt.startsWith("brief")) {
        yield { type: "text_delta", text: `child output for ${txt}` };
        yield { type: "message_stop", stopReason: "end_turn", usage: { ...USAGE } };
        return;
      }
      yield { type: "text_delta", text: "parent done" };
      yield { type: "message_stop", stopReason: "end_turn", usage: { ...USAGE } };
    },
  };
}

function toolResultText(result: RunTurnRpcResult): string {
  const msg = result.messages.find(
    (m) => m.role === "user" && m.content.some((b) => b.type === "tool_result"),
  );
  const block = msg?.content.find((b) => b.type === "tool_result") as { content?: string } | undefined;
  return block?.content ?? "";
}

async function startDaemon(opts: {
  budgets?: Record<string, number>;
  adapter?: ProviderAdapter;
  onCall?: () => void;
  gitRepo?: boolean;
}) {
  const root = tempDir("agency-dh35-root-");
  if (opts.gitRepo) {
    execFileSync("git", ["init", "-q"], { cwd: root });
    execFileSync("git", ["config", "user.email", "qa@example.com"], { cwd: root });
    execFileSync("git", ["config", "user.name", "qa"], { cwd: root });
    writeFileSync(join(root, "app.ts"), "export const v = 1;\n");
    execFileSync("git", ["add", "."], { cwd: root });
    execFileSync("git", ["commit", "-qm", "init"], { cwd: root });
  }
  const sessionsDir = tempDir("agency-dh35-sess-");
  let calls = 0;
  const inner = opts.adapter ?? dispatchAdapter();
  const counting: ProviderAdapter = {
    family: "fake",
    stream: (req, http) => {
      calls++;
      opts.onCall?.();
      return inner.stream(req, http);
    },
  };
  const daemon = await createAgentDaemon({
    workspaceRoot: root,
    instanceFile: join(tempDir("agency-dh35-inst-"), "instance.json"),
    adapterFor: () => counting,
    http: noopHttp,
    configDir: writeConfigDir(teamCfg(opts.budgets ? { budgets: opts.budgets } : undefined)),
    sessionsDir,
  });
  daemons.push(daemon);
  const client = await connectToDaemon(daemon.server.port, "127.0.0.1", { token: daemon.server.token });
  clients.push(client);
  return { daemon, client, sessionsDir, calls: () => calls };
}

describe("dispatch hardening (item 35)", () => {
  it("dispatch tool path: real turns, per-child traces, priced cost, idle lifecycle, namespaced worktrees", async () => {
    // Real git repo: peers get .agency/worktrees/<parent>/<handle> and a
    // child session id carrying parent plus batch, never team-<handle>.
    const { client, sessionsDir } = await startDaemon({ gitRepo: true });
    const result = (await client.call("run_turn", {
      turnId: "dh35-parent",
      provider: "anthropic",
      model: PRICED_MODEL,
      apiKey: "key",
      systemPrompt: "sys",
      session: [{ role: "user", content: [{ type: "text", text: "please dispatch" }] }],
      sessionId: "dh35-parent-session",
    })) as RunTurnRpcResult;
    expect(result.stopReason).toBe("end_turn");
    const text = toolResultText(result);
    expect(text).toContain("w1");
    expect(text).toContain("w2");
    expect(text).toContain("child output for brief one");
    expect(text).toContain("child output for brief two");

    const agents = (await client.call("agents_list", {})) as Array<{
      handle: string;
      state: string;
      costUsd: number;
    }>;
    for (const h of ["w1", "w2"]) {
      const a = agents.find((x) => x.handle === h)!;
      expect(a.state).toBe("idle");
      expect(a.costUsd).toBeGreaterThan(0);
    }
    // traceRecorder per child: one trace file per dispatched session.
    expect(existsSync(join(sessionsDir, "team-dh35-parent-session-w1-b0.trace.jsonl"))).toBe(true);
    expect(existsSync(join(sessionsDir, "team-dh35-parent-session-w2-b0.trace.jsonl"))).toBe(true);
  });

  it("dispatch_compare refuses once the team budget is hit (no spawn, no model call)", async () => {
    let calls = 0;
    const { client } = await startDaemon({
      budgets: { teamUsd: 0.001 },
      adapter: {
        family: "fake",
        async *stream(): AsyncIterable<StreamEvent> {
          calls++;
          yield { type: "text_delta", text: "compare output" };
          yield { type: "message_stop", stopReason: "end_turn", usage: { ...USAGE } };
        },
      },
    });
    // One sonnet turn costs (1000/1e6)*3 + (500/1e6)*15 = 0.0105 > 0.001.
    const first = (await client.call("dispatch_compare", { handles: ["w1"], prompt: "p" })) as {
      results: Array<{ handle: string; result: string }>;
    };
    expect(first.results[0]!.result).toContain("compare output");
    expect(calls).toBe(1);

    const second = (await client.call("dispatch_compare", { handles: ["w1"], prompt: "p" })) as {
      results: Array<{ handle: string; result: string }>;
    };
    expect(second.results[0]!.result).toMatch(/team budget exceeded/);
    expect(calls).toBe(1);
  });

  it("dispatch_compare refuses once the per-agent budget is hit", async () => {
    let calls = 0;
    const { client } = await startDaemon({
      budgets: { perAgentUsd: 0.001 },
      adapter: {
        family: "fake",
        async *stream(): AsyncIterable<StreamEvent> {
          calls++;
          yield { type: "text_delta", text: "compare output" };
          yield { type: "message_stop", stopReason: "end_turn", usage: { ...USAGE } };
        },
      },
    });
    const first = (await client.call("dispatch_compare", { handles: ["w1"], prompt: "p" })) as {
      results: Array<{ handle: string; result: string }>;
    };
    expect(first.results[0]!.result).toContain("compare output");
    expect(calls).toBe(1);

    const second = (await client.call("dispatch_compare", { handles: ["w1"], prompt: "p" })) as {
      results: Array<{ handle: string; result: string }>;
    };
    expect(second.results[0]!.result).toMatch(/per-agent/);
    expect(calls).toBe(1);
  });

  it("dispatch_compare marks failed lifecycle when the child turn throws", async () => {
    const { client } = await startDaemon({
      adapter: {
        family: "fake",
        // biome-ignore lint/correctness/useYield: mock that intentionally throws
        async *stream(): AsyncIterable<StreamEvent> {
          throw new Error("boom-fail-35");
        },
      },
    });
    const res = (await client.call("dispatch_compare", { handles: ["w1"], prompt: "p" })) as {
      results: Array<{ handle: string; result: string }>;
    };
    expect(res.results[0]!.result).toContain("boom-fail-35");
    const agents = (await client.call("agents_list", {})) as Array<{ handle: string; state: string }>;
    expect(agents.find((a) => a.handle === "w1")!.state).toBe("failed");
  });
});
