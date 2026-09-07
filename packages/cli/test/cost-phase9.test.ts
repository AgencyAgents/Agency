import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BoardStore } from "@agency/core";
import type { HttpClient } from "@agency/net";
import type { ModelPricing, ProviderAdapter, StreamEvent, Usage } from "@agency/providers";
import { connectToDaemon, type DaemonClient } from "@agency/rpc";
import { recordTurnUsage, teamRunUsage } from "../src/daemon/costing.ts";
import { createTeamContext } from "../src/daemon/team-context.ts";
import type { DaemonContext } from "../src/daemon/types.ts";
import { type AgentDaemon, createAgentDaemon } from "../src/daemon.ts";

const SONNET: ModelPricing = {
  inputPerMTok: 3,
  outputPerMTok: 15,
  cachedInputPerMTok: 0.3,
  cacheWritePerMTok: 3.75,
};

function stubCtx(parentSessionId: string, board: BoardStore, team: ReturnType<typeof createTeamContext>) {
  return {
    teamContexts: new Map([[parentSessionId, team]]),
    boardStore: board,
  } as unknown as DaemonContext;
}

describe("phase 9 shared cost accounting", () => {
  test("per-agent attribution sums exactly to the run total", () => {
    const board = new BoardStore();
    const team = createTeamContext("parent");
    const ctx = stubCtx("parent", board, team);
    const coderUsage: Usage = {
      inputTokens: 100_000,
      outputTokens: 10_000,
      cachedInputTokens: 60_000,
      cacheWriteInputTokens: 20_000,
    };
    const reviewerUsage: Usage = { inputTokens: 50_000, outputTokens: 5_000 };
    recordTurnUsage({
      team,
      sessionId: "s-coder",
      handle: "coder",
      model: "claude-sonnet-5",
      usage: coderUsage,
      pricing: SONNET,
    });
    recordTurnUsage({
      team,
      sessionId: "s-reviewer",
      handle: "reviewer",
      model: "claude-sonnet-5",
      usage: reviewerUsage,
      pricing: SONNET,
    });
    const run = teamRunUsage(ctx, "parent");
    const sum = Object.values(run.perAgent).reduce((acc, row) => acc + row.costUsd, 0);
    expect(run.totalUsd).toBe(sum);
    expect(run.perAgent.coder?.costUsd).toBeCloseTo(0.303, 9);
    expect(run.perAgent.reviewer?.costUsd).toBeCloseTo(0.225, 9);
    expect(run.perAgent.coder?.cacheHitRate).toBeCloseTo(0.6, 9);
    expect(run.cacheHitRate).toBeCloseTo(60_000 / 150_000, 9);
    expect(run.tokens).toBe(165_000);
  });

  test("per-task attribution lands on the claimed board item", () => {
    const board = new BoardStore();
    const filed = board.file({ content: "ship auth" }, "lead");
    expect(filed.ok).toBe(true);
    const itemId = (filed as { ok: true; item: { id: string } }).item.id;
    expect(board.claim("coder", itemId).ok).toBe(true);
    const team = createTeamContext("parent");
    const ctx = stubCtx("parent", board, team);
    const usage: Usage = { inputTokens: 10_000, outputTokens: 1_000 };
    const cost = recordTurnUsage({
      team,
      sessionId: "s-coder",
      handle: "coder",
      model: "claude-sonnet-5",
      usage,
      pricing: SONNET,
    });
    board.recordCost(itemId, cost, usage.inputTokens + usage.outputTokens);
    const run = teamRunUsage(ctx, "parent");
    expect(run.perTask[itemId]).toEqual({ costUsd: cost, tokens: 11_000 });
  });
});

const noopHttp: HttpClient = { fetch: async () => new Response() };
const daemons: AgentDaemon[] = [];
const clients: DaemonClient[] = [];
const dirs: string[] = [];

const prevKey = process.env.AGENCY_ANTHROPIC_API_KEY;
process.env.AGENCY_ANTHROPIC_API_KEY = "test-key-cost9";
afterAll(() => {
  if (prevKey === undefined) delete process.env.AGENCY_ANTHROPIC_API_KEY;
  else process.env.AGENCY_ANTHROPIC_API_KEY = prevKey;
});

afterEach(async () => {
  for (const c of clients.splice(0)) await c.close();
  for (const d of daemons.splice(0)) await d.stop();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "agency-c9-root-"));
  dirs.push(dir);
  return dir;
}

function writeConfigDir(config: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), "agency-c9-cfg-"));
  dirs.push(dir);
  writeFileSync(join(dir, "config.jsonc"), JSON.stringify({ schemaVersion: 2, ...config }));
  return dir;
}

async function bootCost(
  config: Record<string, unknown>,
  adapterFor: () => ProviderAdapter,
): Promise<{ daemon: AgentDaemon; client: DaemonClient }> {
  const workspaceRoot = tempRoot();
  const daemon = await createAgentDaemon({
    workspaceRoot,
    instanceFile: join(workspaceRoot, ".agency", "instance.json"),
    sessionsDir: (() => {
      const dir = mkdtempSync(join(tmpdir(), "agency-c9-sess-"));
      dirs.push(dir);
      return dir;
    })(),
    adapterFor,
    http: noopHttp,
    configDir: writeConfigDir(config),
  });
  daemons.push(daemon);
  const client = await connectToDaemon(daemon.server.port, "127.0.0.1", { token: daemon.server.token });
  clients.push(client);
  return { daemon, client };
}

function countingAdapter(usage: Usage, text = "done"): { adapter: ProviderAdapter; calls: () => number } {
  let calls = 0;
  return {
    calls: () => calls,
    adapter: {
      family: "fake",
      async *stream(): AsyncIterable<StreamEvent> {
        calls += 1;
        yield { type: "text_delta", text };
        yield { type: "message_stop", stopReason: "end_turn", usage: { ...usage } };
      },
    },
  };
}

const TURN_USAGE: Usage = {
  inputTokens: 1000,
  outputTokens: 100,
  cachedInputTokens: 600,
  cacheWriteInputTokens: 200,
};

function sendParams(sessionId: string): Record<string, unknown> {
  return {
    sessionId,
    provider: "anthropic",
    model: "claude-sonnet-5",
    systemPrompt: "sys",
    userText: "hi",
  };
}

describe("phase 9 daemon cost gates and reports", () => {
  test("a run that would exceed the daily cap is refused before the first provider call", async () => {
    const counted = countingAdapter(TURN_USAGE);
    const { client } = await bootCost({ budgets: { dailyUsd: 0.000001 } }, () => counted.adapter);
    let caught: unknown;
    try {
      await client.call("session_send", sendParams("capped"));
    } catch (error) {
      caught = error;
    }
    expect(String((caught as Error)?.message ?? caught)).toContain("daily cap");
    expect(counted.calls()).toBe(0);
  });

  test("cost_report carries per-agent attribution summing to the run total", async () => {
    const counted = countingAdapter(TURN_USAGE);
    const { client } = await bootCost({}, () => counted.adapter);
    await client.call("session_send", sendParams("run1"));
    await client.call("session_send", sendParams("run1"));
    const cost = (await client.call("cost_report", { sessionId: "run1" })) as {
      sessions: {
        turns: number;
        costUsd: number;
        cachedInputTokens: number;
        cacheWriteInputTokens: number;
        cacheHitRate: number;
      }[];
      total: { turns: number; costUsd: number; cacheHitRate: number };
      perAgent: Record<string, { costUsd: number; cacheHitRate: number }>;
      perTask: Record<string, unknown>;
      runTotalUsd: number;
      runCacheHitRate: number;
      spend: { dayTotalUsd: number; monthTotalUsd: number; caps: Record<string, number> };
    };
    expect(counted.calls()).toBe(2);
    expect(cost.sessions).toHaveLength(1);
    expect(cost.sessions[0]?.turns).toBe(2);
    expect(cost.sessions[0]?.cachedInputTokens).toBe(1200);
    expect(cost.sessions[0]?.cacheWriteInputTokens).toBe(400);
    expect(cost.sessions[0]?.cacheHitRate).toBeCloseTo(0.6, 9);
    expect(cost.total.cacheHitRate).toBeCloseTo(0.6, 9);
    const sum = Object.values(cost.perAgent).reduce((acc, row) => acc + row.costUsd, 0);
    expect(cost.runTotalUsd).toBe(sum);
    expect(cost.runTotalUsd).toBeCloseTo(cost.total.costUsd, 9);
    expect(cost.runCacheHitRate).toBeCloseTo(0.6, 9);
    expect(cost.spend.dayTotalUsd).toBeCloseTo(cost.total.costUsd, 9);
  });

  test("budget is a first-class session parameter", async () => {
    const counted = countingAdapter(TURN_USAGE);
    const { client } = await bootCost({}, () => counted.adapter);
    await client.call("session_create", { sessionId: "budgeted", budget: { maxCostUsd: 0.001 } });
    await client.call("todo_write", {
      sessionId: "budgeted",
      todos: [{ id: "a", content: "do it", status: "pending" }],
    });
    const shown = (await client.call("session_show", { sessionId: "budgeted" })) as {
      budget?: { maxCostUsd: number };
    };
    expect(shown.budget).toEqual({ maxCostUsd: 0.001 });
    let caught: unknown;
    try {
      await client.call("session_send", sendParams("budgeted"));
    } catch (error) {
      caught = error;
    }
    expect(String((caught as Error)?.message ?? caught)).toContain("session budget exceeded");
    expect(counted.calls()).toBe(0);
  });

  test("dispatch announces its estimate on every escalation", async () => {
    const roster = {
      agents: {
        leader: {
          role: "leader",
          provider: "anthropic",
          model: "claude-sonnet-5",
          effort: "low",
          enabled: true,
        },
        worker: {
          role: "worker",
          provider: "anthropic",
          model: "claude-sonnet-5",
          effort: "low",
          enabled: true,
        },
      },
    };
    let adapterCalls = 0;
    let parentStreams = 0;
    const adapterFor = (): ProviderAdapter => {
      adapterCalls += 1;
      if (adapterCalls === 1) {
        return {
          family: "fake",
          async *stream(): AsyncIterable<StreamEvent> {
            parentStreams += 1;
            if (parentStreams === 1) {
              yield { type: "tool_call_start", id: "c1", name: "dispatch" };
              yield {
                type: "tool_call_delta",
                id: "c1",
                inputJsonDelta: JSON.stringify({ agents: [{ handle: "worker", brief: "do work" }] }),
              };
              yield { type: "tool_call_end", id: "c1" };
              yield {
                type: "message_stop",
                stopReason: "tool_use",
                usage: { inputTokens: 10, outputTokens: 5 },
              };
            } else {
              yield { type: "text_delta", text: "parent done" };
              yield {
                type: "message_stop",
                stopReason: "end_turn",
                usage: { inputTokens: 4, outputTokens: 2 },
              };
            }
          },
        };
      }
      return countingAdapter({ inputTokens: 8, outputTokens: 4 }).adapter;
    };
    const { client } = await bootCost(roster, adapterFor);
    const seen: Array<{ type: string; estimate?: { lowUsd: number; highUsd: number } }> = [];
    client.on("team.shared" as never, (p) => seen.push(p as { type: string }));
    client.subscribe("team.shared");
    await new Promise((r) => setTimeout(r, 300));
    await client.call("run_turn", {
      turnId: "c9-dispatch",
      provider: "anthropic",
      model: "claude",
      apiKey: "key",
      systemPrompt: "sys",
      session: [],
    });
    const started = seen.find((e) => e.type === "dispatch_start");
    expect(started?.estimate?.lowUsd).toBeGreaterThan(0);
    expect(started?.estimate?.highUsd).toBeGreaterThanOrEqual(started?.estimate?.lowUsd ?? 0);
  });
});
