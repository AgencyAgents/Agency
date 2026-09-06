import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HttpClient } from "@agency/net";
import type { ProviderAdapter, StreamEvent } from "@agency/providers";
import { connectToDaemon, type DaemonClient } from "@agency/rpc";
import {
  type AgentDaemon,
  checkTeamBudgets,
  createAgentDaemon,
  type RunTurnRpcResult,
} from "../src/daemon.ts";

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
  const dir = mkdtempSync(join(tmpdir(), "agency-b38-"));
  dirs.push(dir);
  return join(dir, "instance.json");
}

function writeConfigDir(config: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), "agency-b38-cfg-"));
  dirs.push(dir);
  writeFileSync(join(dir, "config.jsonc"), JSON.stringify({ schemaVersion: 2, ...config }));
  return dir;
}

function dispatchAdapter(dispatchInput: Record<string, unknown>): ProviderAdapter {
  let call = 0;
  return {
    family: "fake",
    async *stream(): AsyncIterable<StreamEvent> {
      call += 1;
      if (call === 1) {
        yield { type: "tool_call_start", id: "c1", name: "dispatch" };
        yield { type: "tool_call_delta", id: "c1", inputJsonDelta: JSON.stringify(dispatchInput) };
        yield { type: "tool_call_end", id: "c1" };
        yield { type: "message_stop", stopReason: "tool_use", usage: { inputTokens: 1, outputTokens: 1 } };
      } else {
        yield { type: "text_delta", text: "done" };
        yield { type: "message_stop", stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1 } };
      }
    },
  };
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

const roster = {
  agents: {
    leader: {
      role: "GeneralDispatcher",
      provider: "anthropic",
      model: "claude",
      effort: "low",
      enabled: true,
    },
    worker: { role: "Worker", provider: "openai", model: "gpt-5", effort: "low", enabled: true },
  },
};

function toolResultOf(result: RunTurnRpcResult): { isError?: boolean; content?: string } | undefined {
  const content = result.messages[1]?.content[0] as
    | { type?: string; isError?: boolean; content?: string }
    | undefined;
  if (content?.type === "tool_result") return content;
  return undefined;
}

describe("checkTeamBudgets", () => {
  test("throws per-agent when that handle already spent its cap", () => {
    expect(() =>
      checkTeamBudgets({
        budgets: { perAgentUsd: 1 },
        perAgentSpend: new Map([["worker", 1.5]]),
        teamTotal: 0,
        handles: ["worker"],
      }),
    ).toThrow("budget exceeded");
  });

  test("throws per-agent at exactly the cap", () => {
    expect(() =>
      checkTeamBudgets({
        budgets: { perAgentUsd: 2 },
        perAgentSpend: new Map([["worker", 2]]),
        teamTotal: 0,
        handles: ["worker"],
      }),
    ).toThrow("per-agent worker");
  });

  test("other handles under cap do not trip the per-agent check", () => {
    expect(() =>
      checkTeamBudgets({
        budgets: { perAgentUsd: 1 },
        perAgentSpend: new Map([["leader", 5]]),
        teamTotal: 0,
        handles: ["worker"],
      }),
    ).not.toThrow();
  });

  test("throws team when the running total hit the cap", () => {
    expect(() =>
      checkTeamBudgets({
        budgets: { teamUsd: 3 },
        perAgentSpend: new Map(),
        teamTotal: 3,
        handles: ["worker"],
      }),
    ).toThrow("team budget exceeded");
  });

  test("passes under both caps and with no budgets configured", () => {
    expect(() =>
      checkTeamBudgets({
        budgets: { perAgentUsd: 10, teamUsd: 100 },
        perAgentSpend: new Map([["worker", 1]]),
        teamTotal: 5,
        handles: ["worker"],
      }),
    ).not.toThrow();
    expect(() =>
      checkTeamBudgets({
        budgets: undefined,
        perAgentSpend: new Map(),
        teamTotal: 999,
        handles: ["worker"],
      }),
    ).not.toThrow();
  });
});

describe("team budgets in daemon", () => {
  test("dispatch blocked by per-agent cap returns isError and spawns nothing", async () => {
    const sessionsDir = mkdtempSync(join(tmpdir(), "agency-b38-sess-"));
    dirs.push(sessionsDir);
    let runs = 0;
    const daemon = await createAgentDaemon({
      workspaceRoot: "/repo/fake",
      instanceFile: tempInstanceFile(),
      sessionsDir,
      adapterFor: () => {
        runs += 1;
        return dispatchAdapter({ agents: [{ handle: "worker", brief: "do work" }] });
      },
      http: noopHttp,
      configDir: writeConfigDir({ ...roster, budgets: { perAgentUsd: 1 } }),
    });
    daemons.push(daemon);
    const client = await connectToDaemon(daemon.server.port, "127.0.0.1", { token: daemon.server.token });
    clients.push(client);

    const agents = (await client.call("agents_list", {})) as Array<{ handle: string; sessionId: string }>;
    const worker = agents.find((a) => a.handle === "worker")!;
    const now = new Date().toISOString();
    writeFileSync(
      join(sessionsDir, `${worker.sessionId}.trace.jsonl`),
      `${JSON.stringify({ traceId: "t1", spanId: "s1", parentId: null, name: "model:gpt-5", kind: "model", startTime: now, endTime: now, durationMs: 10, status: "ok", attributes: { cost: 2.5 } })}\n`,
    );

    const result = (await client.call("run_turn", {
      turnId: "b38-peragent",
      provider: "anthropic",
      model: "claude",
      apiKey: "key",
      systemPrompt: "sys",
      session: [],
    })) as RunTurnRpcResult;
    const toolResult = toolResultOf(result);
    expect(toolResult?.isError).toBe(true);
    expect(toolResult?.content).toContain("budget exceeded");

    const after = (await client.call("agents_list", {})) as Array<{ handle: string; state: string }>;
    expect(after.find((a) => a.handle === "worker")!.state).toBe("idle");
    expect(runs).toBe(1);
  });

  test("team cap already spent makes run_turn throw before any dispatch", async () => {
    const daemon = await createAgentDaemon({
      workspaceRoot: "/repo/fake",
      instanceFile: tempInstanceFile(),
      adapterFor: () => dispatchAdapter({ agents: [{ handle: "worker", brief: "do work" }] }),
      http: noopHttp,
      configDir: writeConfigDir({ ...roster, budgets: { teamUsd: 0 } }),
    });
    daemons.push(daemon);
    const client = await connectToDaemon(daemon.server.port, "127.0.0.1", { token: daemon.server.token });
    clients.push(client);

    let caught: unknown;
    try {
      await client.call("run_turn", {
        turnId: "b38-team",
        provider: "anthropic",
        model: "claude",
        apiKey: "key",
        systemPrompt: "sys",
        session: [],
      });
    } catch (e) {
      caught = e;
    }
    expect(String((caught as Error)?.message ?? caught)).toContain("team budget exceeded");
  });

  test("costUsdForHandle sums every model trace span", async () => {
    const sessionsDir = mkdtempSync(join(tmpdir(), "agency-b38-sum-"));
    dirs.push(sessionsDir);
    const daemon = await createAgentDaemon({
      workspaceRoot: "/repo/fake",
      instanceFile: tempInstanceFile(),
      sessionsDir,
      adapterFor: () => textAdapter("hi"),
      http: noopHttp,
      configDir: writeConfigDir(roster),
    });
    daemons.push(daemon);
    const client = await connectToDaemon(daemon.server.port, "127.0.0.1", { token: daemon.server.token });
    clients.push(client);

    const agents = (await client.call("agents_list", {})) as Array<{
      handle: string;
      sessionId: string;
      costUsd: number;
    }>;
    const worker = agents.find((a) => a.handle === "worker")!;
    expect(worker.costUsd).toBe(0);
    const now = new Date().toISOString();
    const span = (id: string, cost: number) =>
      JSON.stringify({
        traceId: "t1",
        spanId: id,
        parentId: null,
        name: "model:gpt-5",
        kind: "model",
        startTime: now,
        endTime: now,
        durationMs: 10,
        status: "ok",
        attributes: { cost },
      });
    writeFileSync(
      join(sessionsDir, `${worker.sessionId}.trace.jsonl`),
      `${span("s1", 0.5)}\n${span("s2", 0.75)}\n`,
    );

    const after = (await client.call("agents_list", {})) as Array<{ handle: string; costUsd: number }>;
    expect(after.find((a) => a.handle === "worker")!.costUsd).toBeCloseTo(1.25);
  });

  test("run_turn for an agent session throws once its trace-span cost hit perAgentUsd", async () => {
    const sessionsDir = mkdtempSync(join(tmpdir(), "agency-b38-agent-"));
    dirs.push(sessionsDir);
    const daemon = await createAgentDaemon({
      workspaceRoot: "/repo/fake",
      instanceFile: tempInstanceFile(),
      sessionsDir,
      adapterFor: () => textAdapter("hi"),
      http: noopHttp,
      configDir: writeConfigDir({ ...roster, budgets: { perAgentUsd: 1 } }),
    });
    daemons.push(daemon);
    const client = await connectToDaemon(daemon.server.port, "127.0.0.1", { token: daemon.server.token });
    clients.push(client);

    const agents = (await client.call("agents_list", {})) as Array<{ handle: string; sessionId: string }>;
    const worker = agents.find((a) => a.handle === "worker")!;
    const now = new Date().toISOString();
    writeFileSync(
      join(sessionsDir, `${worker.sessionId}.trace.jsonl`),
      `${JSON.stringify({ traceId: "t1", spanId: "s1", parentId: null, name: "model:gpt-5", kind: "model", startTime: now, endTime: now, durationMs: 10, status: "ok", attributes: { cost: 1.5 } })}\n`,
    );

    let caught: unknown;
    try {
      await client.call("run_turn", {
        turnId: "b38-runturn",
        provider: "openai",
        model: "gpt-5",
        apiKey: "key",
        systemPrompt: "sys",
        session: [],
        sessionId: worker.sessionId,
      });
    } catch (e) {
      caught = e;
    }
    expect(String((caught as Error)?.message ?? caught)).toContain("budget exceeded");
  });
});
