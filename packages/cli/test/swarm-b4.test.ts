import { describe, it, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HttpClient } from "@agency/net";
import type { ProviderAdapter } from "@agency/providers";
import { connectToDaemon, type DaemonClient } from "@agency/rpc";
import { createAgentDaemon, type AgentDaemon } from "../src/daemon.ts";
import { createDispatchTool } from "@agency/core";

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
      yield { type: "message_stop" as const, stopReason: "end_turn" as const, usage: { inputTokens: 3, outputTokens: 2 } };
    },
  };
}

describe("B4 swarm RPC", () => {
  it("agents_list shape with fake roster", async () => {
    const cfg = {
      agents: {
        marshal: { role: "Marshal", provider: "anthropic", model: "claude", effort: "auto" },
        reviewer: { role: "Reviewer", provider: "openai", model: "gpt-5", effort: "high" },
      },
      leader: "marshal",
    };
    const daemon = await createAgentDaemon({
      workspaceRoot: "/repo/fake",
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
    const marshal = agents.find((a) => a.handle === "marshal")!;
    expect(marshal.role).toBe("Marshal");
    expect(marshal.provider).toBe("anthropic");
    expect(marshal.model).toBe("claude");
    expect(marshal.effort).toBe("auto");
    expect(["idle", "working", "blocked", "failed"].includes(String(marshal.state))).toBe(true);
    expect(typeof marshal.sessionId).toBe("string");
    expect(typeof marshal.costUsd).toBe("number");
    const reviewer = agents.find((a) => a.handle === "reviewer")!;
    expect(reviewer.role).toBe("Reviewer");
    expect(reviewer.costUsd).toBe(0);
  });

  it("solo room agents_list returns just leader and emits no swarm events", async () => {
    const cfg = {
      agents: { solo: { role: "Marshal", provider: "anthropic", model: "claude", effort: "low" } },
    };
    const daemon = await createAgentDaemon({
      workspaceRoot: "/repo/fake",
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
    expect(agents[0]!.handle).toBe("solo");

    let swarmEvent = false;
    client.on("swarm.shared" as never, () => (swarmEvent = true));
    client.subscribe("swarm.shared");
    // dispatch should not broadcast when roster is 1 — we test dispatch_compare with solo handle still not broadcasting?
    // Instead verify that a normal run_turn does not emit swarm events.
    await client.call("run_turn", {
      turnId: "solo-t1",
      provider: "anthropic",
      model: "claude",
      apiKey: "key",
      systemPrompt: "sys",
      session: [],
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(swarmEvent).toBe(false);
  });

  it("agent_history returns entries for that handle", async () => {
    const cfg = {
      agents: {
        marshal: { role: "Marshal", provider: "anthropic", model: "claude", effort: "low" },
        smith: { role: "Smith", provider: "openai", model: "gpt-5", effort: "low" },
      },
    };
    const daemon = await createAgentDaemon({
      workspaceRoot: "/repo/fake",
      instanceFile: tempInstanceFile(),
      adapterFor: () => textAdapter("hello"),
      http: noopHttp,
      configDir: writeConfigDir(cfg),
    });
    daemons.push(daemon);
    const client = await connectToDaemon(daemon.server.port, "127.0.0.1", { token: daemon.server.token });
    clients.push(client);

    const history = (await client.call("agent_history", { handle: "smith" })) as { handle: string; sessionId: string; entries: unknown[]; messages: unknown[] };
    expect(history.handle).toBe("smith");
    expect(typeof history.sessionId).toBe("string");
    expect(Array.isArray(history.entries)).toBe(true);
    expect(Array.isArray(history.messages)).toBe(true);
  });

  it("swarm_status rollup includes agents and todo and costTotal", async () => {
    const cfg = {
      agents: {
        a: { role: "A", provider: "anthropic", model: "claude", effort: "low" },
        b: { role: "B", provider: "openai", model: "gpt-5", effort: "low" },
      },
    };
    const daemon = await createAgentDaemon({
      workspaceRoot: "/repo/fake",
      instanceFile: tempInstanceFile(),
      adapterFor: () => textAdapter("hello"),
      http: noopHttp,
      configDir: writeConfigDir(cfg),
    });
    daemons.push(daemon);
    const client = await connectToDaemon(daemon.server.port, "127.0.0.1", { token: daemon.server.token });
    clients.push(client);

    const status = (await client.call("swarm_status", {})) as { agents: Array<{ costUsd: number }>; todo: unknown[]; costTotal: number };
    expect(Array.isArray(status.agents)).toBe(true);
    expect(status.agents.length).toBe(2);
    expect(Array.isArray(status.todo)).toBe(true);
    const sum = status.agents.reduce((s, a) => s + (a.costUsd ?? 0), 0);
    expect(status.costTotal).toBe(sum);
  });

  it("dispatch_compare returns paired results", async () => {
    const cfg = {
      agents: {
        marshal: { role: "Marshal", provider: "anthropic", model: "claude", effort: "auto" },
        reviewer: { role: "Reviewer", provider: "openai", model: "gpt-5", effort: "high" },
      },
    };
    const daemon = await createAgentDaemon({
      workspaceRoot: "/repo/fake",
      instanceFile: tempInstanceFile(),
      adapterFor: () => textAdapter("hello"),
      http: noopHttp,
      configDir: writeConfigDir(cfg),
    });
    daemons.push(daemon);
    const client = await connectToDaemon(daemon.server.port, "127.0.0.1", { token: daemon.server.token });
    clients.push(client);

    const res = (await client.call("dispatch_compare", { handles: ["marshal", "reviewer"], prompt: "compare prompt" })) as { results: Array<{ handle: string; result: string }> };
    expect(res.results.length).toBe(2);
    expect(res.results.map((r) => r.handle).sort()).toEqual(["marshal", "reviewer"]);
    for (const r of res.results) expect(r.result).toContain("compare prompt");
  });

  it("agent_lifecycle events broadcast on swarm.<sessionId> stream", async () => {
    const cfg = {
      agents: {
        marshal: { role: "Marshal", provider: "anthropic", model: "claude", effort: "low" },
        porter: { role: "Porter", provider: "anthropic", model: "claude", effort: "low" },
      },
    };
    const daemon = await createAgentDaemon({
      workspaceRoot: "/repo/fake",
      instanceFile: tempInstanceFile(),
      adapterFor: () => textAdapter("hi"),
      http: noopHttp,
      configDir: writeConfigDir(cfg),
    });
    daemons.push(daemon);
    const client = await connectToDaemon(daemon.server.port, "127.0.0.1", { token: daemon.server.token });
    clients.push(client);

    const agents = (await client.call("agents_list", {})) as Array<{ handle: string; sessionId: string }>;
    const porter = agents.find((a) => a.handle === "porter")!;
    const events: unknown[] = [];
    client.on(`swarm.${porter.sessionId}` as never, (p) => events.push(p));
    client.subscribe(`swarm.${porter.sessionId}`);

    await client.call("dispatch_compare", { handles: ["porter"], prompt: "do work" });
    await new Promise((r) => setTimeout(r, 80));
    expect(events.some((e) => (e as { state?: string }).state === "working")).toBe(true);
  });

  it("dispatch tool renderResult produces one collapsed line per agent", async () => {
    const tool = createDispatchTool({ dispatch: async () => ({ content: "a dispatched: foo\nb dispatched: bar" }) });
    const call = (tool as unknown as { renderCall: (i: unknown) => string }).renderCall?.({ agents: [{ handle: "a", brief: "foo" }, { handle: "b", brief: "bar" }] });
    expect(call).toContain("a");
    expect(call).toContain("b");
    const res = (tool as unknown as { renderResult: (r: unknown) => string }).renderResult?.({ content: "a dispatched: foo\nb dispatched: bar", isError: false });
    expect(res!.split("\n").length).toBe(1);
    expect(res).toContain("2 agents");
  });

  it("per-agent cost rollup from trace spans", async () => {
    const sessionsDir = mkdtempSync(join(tmpdir(), "agency-b4-sess-"));
    dirs.push(sessionsDir);
    const cfg = {
      agents: {
        porter: { role: "Porter", provider: "anthropic", model: "claude", effort: "low" },
        reviewer: { role: "Reviewer", provider: "openai", model: "gpt-5", effort: "low" },
      },
    };
    const daemon = await createAgentDaemon({
      workspaceRoot: "/repo/fake",
      instanceFile: tempInstanceFile(),
      sessionsDir,
      adapterFor: () => textAdapter("hi"),
      http: noopHttp,
      configDir: writeConfigDir(cfg),
    });
    daemons.push(daemon);
    const client = await connectToDaemon(daemon.server.port, "127.0.0.1", { token: daemon.server.token });
    clients.push(client);

    const agents = (await client.call("agents_list", {})) as Array<{ handle: string; sessionId: string; costUsd: number }>;
    const porter = agents.find((a) => a.handle === "porter")!;
    expect(porter.costUsd).toBe(0);

    const tracePath = join(sessionsDir, `${porter.sessionId}.trace.jsonl`);
    const now = new Date().toISOString();
    const span = JSON.stringify({ traceId: "t1", spanId: "s1", parentId: null, name: "model:claude", kind: "model", startTime: now, endTime: now, durationMs: 100, status: "ok", attributes: { provider: "anthropic", model: "claude", cost: 1.23 } });
    writeFileSync(tracePath, `${span}\n`);

    const agents2 = (await client.call("agents_list", {})) as Array<{ handle: string; costUsd: number }>;
    const porter2 = agents2.find((a) => a.handle === "porter")!;
    expect(porter2.costUsd).toBeCloseTo(1.23);

    const status = (await client.call("swarm_status", {})) as { costTotal: number; agents: Array<{ costUsd: number }> };
    expect(status.costTotal).toBeCloseTo(1.23);
  });

  it("dispatch result renderResult is a single collapsed line containing handle", async () => {
    const { createDispatchTool: createDispatchTool2 } = await import("@agency/core");
    const tool = createDispatchTool2({ dispatch: async () => ({ content: "porter dispatched at low: do thing" }) });
    const renderResult = (tool as unknown as { renderResult: (r: unknown) => string }).renderResult;
    const result = renderResult({ content: "porter dispatched at low: do thing", isError: false });
    expect(result.split("\n").length).toBe(1);
    expect(result).toContain("porter");
  });
});
