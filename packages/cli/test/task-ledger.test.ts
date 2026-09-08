import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BoardStore } from "@agency/core";
import type { ModelPricing, Usage } from "@agency/providers";
import { AgencyError, ErrorCode } from "@agency/schema";
import { SpendLedger } from "@agency/telemetry";
import { estimatePreflightTurnCostUsd, recordTurnCompletion, teamRunUsage } from "../src/daemon/costing.ts";
import { assertTaskPreflightCaps, TaskUsageTracker } from "../src/daemon/task-ledger.ts";
import { createTeamContext } from "../src/daemon/team-context.ts";
import type { DaemonContext } from "../src/daemon/types.ts";

const SONNET: ModelPricing = {
  inputPerMTok: 3,
  outputPerMTok: 15,
  cachedInputPerMTok: 0.3,
  cacheWritePerMTok: 3.75,
};

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

function stubCtx(board: BoardStore, team: ReturnType<typeof createTeamContext>, ledger?: TaskUsageTracker) {
  return {
    teamContexts: new Map([["parent", team]]),
    boardStore: board,
    spendLedger: new SpendLedger(),
    eventBus: { emit() {} },
    broadcast() {},
    ...(ledger === undefined ? {} : { taskLedger: ledger }),
  } as unknown as DaemonContext;
}

function claim(board: BoardStore, handle: string, content: string, budgets?: { budgetUsd?: number; budgetTurns?: number }): string {
  const filed = board.file({ content, ...budgets }, "lead");
  expect(filed.ok).toBe(true);
  const id = (filed as { ok: true; item: { id: string } }).item.id;
  expect(board.claim(handle, id).ok).toBe(true);
  return id;
}

function complete(
  ctx: DaemonContext,
  team: ReturnType<typeof createTeamContext>,
  args: {
    handle: string;
    usage: Usage;
    pricing?: ModelPricing;
    board?: BoardStore;
    taskId?: string;
  },
): number {
  return recordTurnCompletion(ctx, {
    team,
    sessionId: `s-${args.handle}`,
    handle: args.handle,
    model: "claude-sonnet-5",
    usage: args.usage,
    ...(args.pricing === undefined ? {} : { pricing: args.pricing }),
    ...(args.board === undefined ? {} : { board: args.board }),
    ...(args.taskId === undefined ? {} : { taskId: args.taskId }),
  });
}

describe("task-ledger", () => {
  test("multi-turn tasks aggregate exactly, single-counted across board and ledger", () => {
    const board = new BoardStore();
    const taskA = claim(board, "coder", "ship auth");
    const taskB = claim(board, "reviewer", "review auth");
    const team = createTeamContext("parent");
    const ledger = new TaskUsageTracker();
    const ctx = stubCtx(board, team, ledger);
    const u1: Usage = { inputTokens: 100_000, outputTokens: 10_000 };
    const u2: Usage = { inputTokens: 50_000, outputTokens: 5_000 };
    complete(ctx, team, { handle: "coder", usage: u1, pricing: SONNET, board });
    complete(ctx, team, { handle: "coder", usage: u2, pricing: SONNET, board });
    complete(ctx, team, { handle: "reviewer", usage: u1, pricing: SONNET, board });
    // (0.1*3 + 0.01*15) = 0.45 ; (0.05*3 + 0.005*15) = 0.225
    expect(ledger.totalsFor(taskA).turns).toBe(2);
    expect(ledger.totalsFor(taskA).costUsd).toBeCloseTo(0.675, 9);
    expect(ledger.totalsFor(taskA).tokens).toBe(165_000);
    expect(ledger.totalsFor(taskB).costUsd).toBeCloseTo(0.45, 9);
    expect(ledger.totalsFor(taskB).tokens).toBe(110_000);
    const run = teamRunUsage(ctx, "parent");
    expect(run.perTask[taskA]).toEqual({ costUsd: ledger.totalsFor(taskA).costUsd, tokens: 165_000 });
    expect(run.perTask[taskB]).toEqual({ costUsd: ledger.totalsFor(taskB).costUsd, tokens: 110_000 });
  });

  test("usd cap breach throws typed before any provider invocation", () => {
    const board = new BoardStore();
    const taskA = claim(board, "coder", "ship auth", { budgetUsd: 0.01 });
    const team = createTeamContext("parent");
    const ledger = new TaskUsageTracker();
    const ctx = stubCtx(board, team, ledger);
    complete(ctx, team, {
      handle: "coder",
      usage: { inputTokens: 100_000, outputTokens: 10_000 },
      pricing: SONNET,
      board,
    });
    let providerCalls = 0;
    const gatedProviderCall = () => {
      assertTaskPreflightCaps({ board, ledger, handle: "coder" });
      providerCalls += 1;
    };
    let thrown: unknown;
    try {
      gatedProviderCall();
    } catch (error) {
      thrown = error;
    }
    expect(thrown instanceof AgencyError && thrown.code === ErrorCode.PERMISSION_DENIED).toBe(true);
    expect(String((thrown as Error).message)).toMatch(taskA);
    expect(providerCalls).toBe(0);
  });

  test("estimate pushes just-under-cap spend over: blocks with zero provider calls", () => {
    const board = new BoardStore();
    const estimateUsd = estimatePreflightTurnCostUsd({
      systemPrompt: "system prompt text",
      session: [{ role: "user", content: [{ type: "text", text: "do the work" }] }],
      pricing: SONNET,
    });
    expect(estimateUsd).toBeGreaterThan(0);
    const spentUsd = 0.45;
    const budgetUsd = spentUsd + estimateUsd / 2;
    const taskA = claim(board, "coder", "ship auth", { budgetUsd });
    const team = createTeamContext("parent");
    const ledger = new TaskUsageTracker();
    const ctx = stubCtx(board, team, ledger);
    complete(ctx, team, {
      handle: "coder",
      usage: { inputTokens: 100_000, outputTokens: 10_000 },
      pricing: SONNET,
      board,
    });
    const totals = ledger.totalsFor(taskA);
    expect(totals.costUsd).toBeCloseTo(spentUsd, 9);
    expect(totals.costUsd).toBeLessThan(budgetUsd);
    expect(totals.costUsd + estimateUsd).toBeGreaterThan(budgetUsd);
    let providerCalls = 0;
    let thrown: unknown;
    try {
      assertTaskPreflightCaps({ board, ledger, handle: "coder", estimateUsd });
      providerCalls += 1;
    } catch (error) {
      thrown = error;
    }
    expect(thrown instanceof AgencyError && thrown.code === ErrorCode.PERMISSION_DENIED).toBe(true);
    expect(providerCalls).toBe(0);
  });

  test("turn cap breach throws typed before any provider invocation", () => {
    const board = new BoardStore();
    claim(board, "coder", "ship auth", { budgetTurns: 1 });
    const team = createTeamContext("parent");
    const ledger = new TaskUsageTracker();
    const ctx = stubCtx(board, team, ledger);
    complete(ctx, team, {
      handle: "coder",
      usage: { inputTokens: 1_000, outputTokens: 100 },
      pricing: SONNET,
      board,
    });
    let providerCalls = 0;
    let thrown: unknown;
    try {
      assertTaskPreflightCaps({ board, ledger, handle: "coder" });
      providerCalls += 1;
    } catch (error) {
      thrown = error;
    }
    expect(thrown instanceof AgencyError && thrown.code === ErrorCode.PERMISSION_DENIED).toBe(true);
    expect(String((thrown as Error).message)).toMatch("turn cap");
    expect(providerCalls).toBe(0);
  });

  test("history query returns exact per-turn breakdowns; unknown task is zeros", () => {
    const board = new BoardStore();
    const taskA = claim(board, "coder", "ship auth");
    const taskB = claim(board, "reviewer", "review auth");
    const team = createTeamContext("parent");
    const ledger = new TaskUsageTracker();
    const ctx = stubCtx(board, team, ledger);
    const turns: Usage[] = [
      { inputTokens: 10_000, outputTokens: 1_000 },
      { inputTokens: 20_000, outputTokens: 2_000 },
      { inputTokens: 30_000, outputTokens: 3_000 },
    ];
    for (const usage of turns) complete(ctx, team, { handle: "coder", usage, pricing: SONNET, board });
    complete(ctx, team, {
      handle: "reviewer",
      usage: { inputTokens: 5_000, outputTokens: 500 },
      pricing: SONNET,
      board,
    });
    const history = ledger.historyFor(taskA);
    expect(history.length).toBe(3);
    expect(history.map((e) => e.tokens)).toEqual([11_000, 22_000, 33_000]);
    expect(history.map((e) => e.taskId)).toEqual([taskA, taskA, taskA]);
    expect(history[0]?.costUsd).toBeCloseTo(0.045, 9);
    expect(history[2]?.costUsd).toBeCloseTo(0.135, 9);
    expect(ledger.historyFor(taskB).length).toBe(1);
    expect(ledger.historyFor("no-such-task")).toEqual([]);
    expect(ledger.totalsFor("no-such-task")).toEqual({ turns: 0, costUsd: 0, tokens: 0, inputTokens: 0, outputTokens: 0 });
  });

  test("missing pricing records zero cost with tokens preserved, never crashes", () => {
    const board = new BoardStore();
    const taskA = claim(board, "coder", "local ollama work");
    const team = createTeamContext("parent");
    const ledger = new TaskUsageTracker();
    const ctx = stubCtx(board, team, ledger);
    const cost = complete(ctx, team, {
      handle: "coder",
      usage: { inputTokens: 8_000, outputTokens: 2_000 },
      board,
    });
    expect(cost).toBe(0);
    const history = ledger.historyFor(taskA);
    expect(history.length).toBe(1);
    expect(history[0]?.pricingMissing).toBe(true);
    expect(history[0]?.tokens).toBe(10_000);
    expect(ledger.totalsFor(taskA)).toEqual({
      turns: 1,
      costUsd: 0,
      tokens: 10_000,
      inputTokens: 8_000,
      outputTokens: 2_000,
    });
    expect(teamRunUsage(ctx, "parent").perTask[taskA]).toEqual({ costUsd: 0, tokens: 10_000 });
  });

  test("corrupt ledger lines skip with warnings; valid entries survive reload", () => {
    const dir = tempDir("agency-task-ledger-");
    const file = join(dir, "task-ledger.jsonl");
    writeFileSync(
      file,
      [
        '{"taskId":"t1","costUsd":0.5,"tokens":1000,"inputTokens":900,"outputTokens":100,"model":"m","handle":"coder","pricingMissing":false,"at":1}',
        "not-json{{{",
        '{"taskId":"","costUsd":"bad","tokens":null}',
        "",
      ].join("\n"),
      "utf8",
    );
    const warnings: string[] = [];
    const ledger = new TaskUsageTracker({ file, onWarn: (m) => warnings.push(m) });
    expect(warnings.length).toBeGreaterThanOrEqual(2);
    expect(ledger.totalsFor("t1")).toEqual({
      turns: 1,
      costUsd: 0.5,
      tokens: 1000,
      inputTokens: 900,
      outputTokens: 100,
    });
  });

  test("negative and NaN usage sanitize to zero, never crash", () => {
    const warnings: string[] = [];
    const ledger = new TaskUsageTracker({ onWarn: (m) => warnings.push(m) });
    const entry = ledger.recordTurn("t9", {
      usage: { inputTokens: -5, outputTokens: NaN },
      costUsd: NaN,
      model: "m",
      handle: "coder",
    });
    expect(entry?.costUsd).toBe(0);
    expect(entry?.tokens).toBe(0);
    expect(ledger.totalsFor("t9").tokens).toBe(0);
    expect(ledger.recordTurn("", { usage: { inputTokens: 1, outputTokens: 1 }, costUsd: 1, model: "m", handle: "h" })).toBeNull();
    expect(warnings.length).toBeGreaterThanOrEqual(1);
  });

  test("ledger persists across restarts via the JSONL sidecar", () => {
    const dir = tempDir("agency-task-ledger-");
    const first = new TaskUsageTracker({ sessionsDir: dir });
    first.recordTurn("t1", {
      usage: { inputTokens: 10_000, outputTokens: 1_000 },
      costUsd: 0.045,
      model: "m",
      handle: "coder",
    });
    first.recordTurn("t2", {
      usage: { inputTokens: 4_000, outputTokens: 1_000 },
      costUsd: 0.027,
      model: "m",
      handle: "reviewer",
    });
    const text = readFileSync(join(dir, "task-ledger.jsonl"), "utf8");
    expect(text.split("\n").filter((l) => l.length > 0).length).toBe(2);
    const second = new TaskUsageTracker({ sessionsDir: dir });
    expect(second.totalsFor("t1").costUsd).toBeCloseTo(0.045, 9);
    expect(second.totalsFor("t1").tokens).toBe(11_000);
    expect(second.totalsFor("t2").costUsd).toBeCloseTo(0.027, 9);
    expect(Object.keys(second.perTask()).sort()).toEqual(["t1", "t2"]);
  });

  test("pre-ledger board costs still surface in perTask (shape-compatible fallback)", () => {
    const board = new BoardStore();
    const filed = board.file({ content: "legacy work" }, "lead");
    const id = (filed as { ok: true; item: { id: string } }).item.id;
    board.recordCost(id, 1.25, 5000);
    const team = createTeamContext("parent");
    const ctx = stubCtx(board, team);
    expect(teamRunUsage(ctx, "parent").perTask[id]).toEqual({ costUsd: 1.25, tokens: 5000 });
  });
});
