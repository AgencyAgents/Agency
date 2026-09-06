import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDispatchTool } from "@agency/core";
import type { HttpClient } from "@agency/net";
import type { ProviderAdapter } from "@agency/providers";
import { connectToDaemon, type DaemonClient } from "@agency/rpc";
import { type AgentDaemon, createAgentDaemon } from "../src/daemon.ts";

const noopHttp: HttpClient = { fetch: async () => new Response() };

const daemons: AgentDaemon[] = [];
const clients: DaemonClient[] = [];
const dirs: string[] = [];

afterEach(async () => {
  for (const c of clients.splice(0)) await c.close();
  for (const d of daemons.splice(0)) await d.stop();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempInstanceFile(): string {
  const dir = mkdtempSync(join(tmpdir(), "agency-b4-"));
  dirs.push(dir);
  return join(dir, "instance.json");
}
function tempRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "agency-b4-root-"));
  dirs.push(dir);
  return dir;
}
function writeConfigDir(config: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), "agency-b4-cfg-"));
  dirs.push(dir);
  writeFileSync(join(dir, "config.jsonc"), JSON.stringify({ schemaVersion: 2, ...config }));
  return dir;
}
function textAdapter(text: string): ProviderAdapter {
  return {
    family: "fake",
    async *stream() {
      yield { type: "text_delta" as const, text };
      yield {
        type: "message_stop" as const,
        stopReason: "end_turn" as const,
        usage: { inputTokens: 3, outputTokens: 2 },
      };
    },
  };
}

describe("B4 team RPC", () => {
  it("agents_list shape with fake roster", async () => {
    const cfg = {
      agents: {
        leader: {
          role: "GeneralDispatcher",
          provider: "anthropic",
          model: "claude",
          effort: "auto",
          enabled: true,
        },
        reviewer: { role: "Reviewer", provider: "openai", model: "gpt-5", effort: "high", enabled: true },
      },
    };
    const daemon = await createAgentDaemon({
      workspaceRoot: tempRoot(),
      instanceFile: tempInstanceFile(),
      adapterFor: () => textAdapter("hello"),
      http: noopHttp,
      configDir: writeConfigDir(cfg),
    });
    daemons.push(daemon);
    const client = await connectToDaemon(daemon.server.port, "127.0.0.1", { token: daemon.server.token });
    clients.push(client);

    const agents = (await client.call("agents_list", {})) as Array<Record<string, unknown>>;
    expect(Array.isArray(agents)).toBe(true);
    expect(agents.length).toBe(2);
    const leaderAgent = agents.find((a) => a.handle === "leader")!;
    expect(leaderAgent.role).toBe("GeneralDispatcher");
    expect(leaderAgent.provider).toBe("anthropic");
    expect(leaderAgent.model).toBe("claude");
    expect(leaderAgent.effort).toBe("auto");
    expect(["idle", "working", "blocked", "failed"].includes(String(leaderAgent.state))).toBe(true);
    expect(typeof leaderAgent.sessionId).toBe("string");
    expect(typeof leaderAgent.costUsd).toBe("number");
    const reviewer = agents.find((a) => a.handle === "reviewer")!;
    expect(reviewer.role).toBe("Reviewer");
    expect(reviewer.costUsd).toBe(0);
  });

  it("solo room agents_list returns just leader and emits no team events", async () => {
    const cfg = {
      agents: {
        leader: {
          role: "GeneralDispatcher",
          provider: "anthropic",
          model: "claude",
          effort: "low",
          enabled: true,
        },
      },
    };
    const daemon = await createAgentDaemon({
      workspaceRoot: tempRoot(),
      instanceFile: tempInstanceFile(),
      adapterFor: () => textAdapter("hi"),
      http: noopHttp,
      configDir: writeConfigDir(cfg),
    });
    daemons.push(daemon);
    const client = await connectToDaemon(daemon.server.port, "127.0.0.1", { token: daemon.server.token });
    clients.push(client);

    const agents = (await client.call("agents_list", {})) as Array<Record<string, unknown>>;
    expect(agents.length).toBe(1);
    expect(agents[0]!.handle).toBe("leader");

    let teamEvent = false;
    client.on("team.shared" as never, () => (teamEvent = true));
    client.subscribe("team.shared");
    // dispatch should not broadcast when roster is 1 — we test dispatch_compare with solo handle still not broadcasting?
    // Instead verify that a normal run_turn does not emit team events.
    await client.call("run_turn", {
      turnId: "solo-t1",
      provider: "anthropic",
      model: "claude",
      apiKey: "key",
      systemPrompt: "sys",
      session: [],
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(teamEvent).toBe(false);
  });

  it("agent_history returns entries for that handle", async () => {
    const cfg = {
      agents: {
        leader: {
          role: "GeneralDispatcher",
          provider: "anthropic",
          model: "claude",
          effort: "low",
          enabled: true,
        },
        smith: { role: "Smith", provider: "openai", model: "gpt-5", effort: "low", enabled: true },
      },
    };
    const daemon = await createAgentDaemon({
      workspaceRoot: tempRoot(),
      instanceFile: tempInstanceFile(),
      adapterFor: () => textAdapter("hello"),
      http: noopHttp,
      configDir: writeConfigDir(cfg),
    });
    daemons.push(daemon);
    const client = await connectToDaemon(daemon.server.port, "127.0.0.1", { token: daemon.server.token });
    clients.push(client);

    const history = (await client.call("agent_history", { handle: "smith" })) as {
      handle: string;
      sessionId: string;
      entries: unknown[];
      messages: unknown[];
    };
    expect(history.handle).toBe("smith");
    expect(typeof history.sessionId).toBe("string");
    expect(Array.isArray(history.entries)).toBe(true);
    expect(Array.isArray(history.messages)).toBe(true);
  });

  it("team_status rollup includes agents and todo and costTotal", async () => {
    const cfg = {
      agents: {
        leader: {
          role: "GeneralDispatcher",
          provider: "anthropic",
          model: "claude",
          effort: "low",
          enabled: true,
        },
        b: { role: "B", provider: "openai", model: "gpt-5", effort: "low", enabled: true },
      },
    };
    const daemon = await createAgentDaemon({
      workspaceRoot: tempRoot(),
      instanceFile: tempInstanceFile(),
      adapterFor: () => textAdapter("hello"),
      http: noopHttp,
      configDir: writeConfigDir(cfg),
    });
    daemons.push(daemon);
    const client = await connectToDaemon(daemon.server.port, "127.0.0.1", { token: daemon.server.token });
    clients.push(client);

    const status = (await client.call("team_status", {})) as {
      agents: Array<{ costUsd: number }>;
      todo: unknown[];
      costTotal: number;
    };
    expect(Array.isArray(status.agents)).toBe(true);
    expect(status.agents.length).toBe(2);
    expect(Array.isArray(status.todo)).toBe(true);
    const sum = status.agents.reduce((s, a) => s + (a.costUsd ?? 0), 0);
    expect(status.costTotal).toBe(sum);
  });

  it("dispatch_compare returns real model output per handle", async () => {
    const cfg = {
      agents: {
        leader: {
          role: "GeneralDispatcher",
          provider: "anthropic",
          model: "claude",
          effort: "auto",
          enabled: true,
        },
        reviewer: { role: "Reviewer", provider: "openai", model: "gpt-5", effort: "high", enabled: true },
      },
    };
    // Each agent gets a different adapter output to prove separate model calls
    let callCount = 0;
    const daemon = await createAgentDaemon({
      workspaceRoot: tempRoot(),
      instanceFile: tempInstanceFile(),
      adapterFor: () => {
        callCount++;
        return textAdapter(`real output ${callCount}`);
      },
      http: noopHttp,
      configDir: writeConfigDir(cfg),
    });
    daemons.push(daemon);
    const client = await connectToDaemon(daemon.server.port, "127.0.0.1", { token: daemon.server.token });
    clients.push(client);

    const res = (await client.call("dispatch_compare", {
      handles: ["leader", "reviewer"],
      prompt: "compare prompt",
    })) as { results: Array<{ handle: string; result: string }> };
    expect(res.results.length).toBe(2);
    expect(res.results.map((r) => r.handle).sort()).toEqual(["leader", "reviewer"]);
    // Results should contain real model output, not just the old synthesized string
    for (const r of res.results) {
      expect(r.result).toMatch(/real output/);
    }
  });

  it("agent_lifecycle events broadcast on team.shared with the child session", async () => {
    const cfg = {
      agents: {
        leader: {
          role: "GeneralDispatcher",
          provider: "anthropic",
          model: "claude",
          effort: "low",
          enabled: true,
        },
        porter: { role: "Porter", provider: "anthropic", model: "claude", effort: "low", enabled: true },
      },
    };
    const daemon = await createAgentDaemon({
      workspaceRoot: tempRoot(),
      instanceFile: tempInstanceFile(),
      adapterFor: () => textAdapter("hi"),
      http: noopHttp,
      configDir: writeConfigDir(cfg),
    });
    daemons.push(daemon);
    const client = await connectToDaemon(daemon.server.port, "127.0.0.1", { token: daemon.server.token });
    clients.push(client);

    const agents = (await client.call("agents_list", {})) as Array<{ handle: string; sessionId: string }>;
    expect(agents.some((a) => a.handle === "porter")).toBe(true);
    const events: unknown[] = [];
    client.on("team.shared" as never, (p) => events.push(p));
    client.subscribe("team.shared");

    await client.call("dispatch_compare", { handles: ["porter"], prompt: "do work" });
    await new Promise((r) => setTimeout(r, 80));
    const working = events.filter(
      (e) =>
        (e as { handle?: string; state?: string }).handle === "porter" &&
        (e as { state?: string }).state === "working",
    );
    expect(working.length).toBeGreaterThan(0);
    expect(
      (working[0] as { sessionId?: string }).sessionId ?? (working[0] as { detail?: string }).detail,
    ).toBeDefined();
  });

  it("dispatch tool renderResult produces one collapsed line per agent", async () => {
    const tool = createDispatchTool({
      dispatch: async (_input) => ({ content: "a dispatched: foo\nb dispatched: bar" }),
    });
    const call = (tool as unknown as { renderCall: (i: unknown) => string }).renderCall?.({
      agents: [
        { handle: "a", brief: "foo" },
        { handle: "b", brief: "bar" },
      ],
    });
    expect(call).toContain("a");
    expect(call).toContain("b");
    const res = (tool as unknown as { renderResult: (r: unknown) => string }).renderResult?.({
      content: "a dispatched: foo\nb dispatched: bar",
      isError: false,
    });
    expect(res!.split("\n").length).toBe(1);
    expect(res).toContain("2 agents");
  });

  it("per-agent cost rollup from trace spans", async () => {
    const sessionsDir = mkdtempSync(join(tmpdir(), "agency-b4-sess-"));
    dirs.push(sessionsDir);
    const cfg = {
      agents: {
        leader: {
          role: "GeneralDispatcher",
          provider: "anthropic",
          model: "claude",
          effort: "low",
          enabled: true,
        },
        porter: { role: "Porter", provider: "anthropic", model: "claude", effort: "low", enabled: true },
      },
    };
    const daemon = await createAgentDaemon({
      workspaceRoot: tempRoot(),
      instanceFile: tempInstanceFile(),
      sessionsDir,
      adapterFor: () => textAdapter("hi"),
      http: noopHttp,
      configDir: writeConfigDir(cfg),
    });
    daemons.push(daemon);
    const client = await connectToDaemon(daemon.server.port, "127.0.0.1", { token: daemon.server.token });
    clients.push(client);

    const agents = (await client.call("agents_list", {})) as Array<{
      handle: string;
      sessionId: string;
      costUsd: number;
    }>;
    const porter = agents.find((a) => a.handle === "porter")!;
    expect(porter.costUsd).toBe(0);

    const tracePath = join(sessionsDir, `${porter.sessionId}.trace.jsonl`);
    const now = new Date().toISOString();
    const span = JSON.stringify({
      traceId: "t1",
      spanId: "s1",
      parentId: null,
      name: "model:claude",
      kind: "model",
      startTime: now,
      endTime: now,
      durationMs: 100,
      status: "ok",
      attributes: { provider: "anthropic", model: "claude", cost: 1.23 },
    });
    writeFileSync(tracePath, `${span}\n`);

    const agents2 = (await client.call("agents_list", {})) as Array<{ handle: string; costUsd: number }>;
    const porter2 = agents2.find((a) => a.handle === "porter")!;
    expect(porter2.costUsd).toBeCloseTo(1.23);

    const status = (await client.call("team_status", {})) as {
      costTotal: number;
      agents: Array<{ costUsd: number }>;
    };
    expect(status.costTotal).toBeCloseTo(1.23);
  });

  it("dispatch result renderResult is a single collapsed line containing handle", async () => {
    const { createDispatchTool: createDispatchTool2 } = await import("@agency/core");
    const tool = createDispatchTool2({
      dispatch: async (_input) => ({ content: "porter dispatched at low: do thing" }),
    });
    const renderResult = (tool as unknown as { renderResult: (r: unknown) => string }).renderResult;
    const result = renderResult({ content: "porter dispatched at low: do thing", isError: false });
    expect(result.split("\n").length).toBe(1);
    expect(result).toContain("porter");
  });

  it("mailbox drain keys by handle, not sessionId", async () => {
    const cfg = {
      agents: {
        leader: {
          role: "GeneralDispatcher",
          provider: "anthropic",
          model: "claude",
          effort: "low",
          enabled: true,
        },
        beta: { role: "Beta", provider: "openai", model: "gpt-5", effort: "low", enabled: true },
      },
    };
    const daemon = await createAgentDaemon({
      workspaceRoot: tempRoot(),
      instanceFile: tempInstanceFile(),
      adapterFor: () => textAdapter("hello"),
      http: noopHttp,
      configDir: writeConfigDir(cfg),
    });
    daemons.push(daemon);
    const client = await connectToDaemon(daemon.server.port, "127.0.0.1", { token: daemon.server.token });
    clients.push(client);

    // Send a message to leader by handle
    await client.call("agent_message", { from: "beta", to: "leader", body: "steer message" });

    // Verify the message arrived in leader's mailbox (keyed by handle)
    const agents = (await client.call("agents_list", {})) as Array<{ handle: string; sessionId: string }>;
    const leaderAgent = agents.find((a) => a.handle === "leader")!;

    // Run a turn for leader's session - the drain should pick up the mailbox message
    const result = (await client.call("run_turn", {
      turnId: "leader-t1",
      provider: "anthropic",
      model: "claude",
      apiKey: "key",
      systemPrompt: "sys",
      session: [{ role: "user", content: [{ type: "text", text: "@leader do work" }] }],
      sessionId: leaderAgent.sessionId,
    })) as { messages: Array<{ role: string; content: Array<{ type: string; text?: string }> }> };
    // The mailbox message should have been injected into the turn
    const injected = result.messages.find(
      (m) => m.role === "user" && m.content?.some((c) => c.text?.includes("steer message")),
    );
    expect(injected).toBeDefined();
  });

  it("worktree creation failure falls back to workspace root", async () => {
    const cfg = {
      agents: {
        leader: {
          role: "GeneralDispatcher",
          provider: "anthropic",
          model: "claude",
          effort: "low",
          enabled: true,
        },
      },
    };
    // Use a workspace root that will cause worktree creation to fail (no git repo)
    const nonGitDir = mkdtempSync(join(tmpdir(), "agency-b4-nogit-"));
    dirs.push(nonGitDir);
    const daemon = await createAgentDaemon({
      workspaceRoot: nonGitDir,
      instanceFile: tempInstanceFile(),
      adapterFor: () => textAdapter("fallback ok"),
      http: noopHttp,
      configDir: writeConfigDir(cfg),
    });
    daemons.push(daemon);
    const client = await connectToDaemon(daemon.server.port, "127.0.0.1", { token: daemon.server.token });
    clients.push(client);

    // dispatch_compare should still work even though worktree creation fails
    const res = (await client.call("dispatch_compare", { handles: ["leader"], prompt: "test prompt" })) as {
      results: Array<{ handle: string; result: string }>;
    };
    expect(res.results.length).toBe(1);
    expect(res.results[0]!.result).toMatch(/fallback ok/);
  });
});
