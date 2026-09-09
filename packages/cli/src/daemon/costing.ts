import { announceHook, type BoardStore } from "@agency/core";
import {
  type CostEstimate,
  type DispatchAgentForecast,
  estimateDispatchCost,
  estimateTurnCostUsd,
} from "@agency/guard";
import type { ModelPricing, Usage } from "@agency/providers";
import { AgencyError, ErrorCode, type Message } from "@agency/schema";
import { isUsageEntry, type SpendCaps, type SpendLedger, turnCostUsd } from "@agency/telemetry";
import { resolveTaskId } from "./task-ledger.ts";
import type { TeamContext, TurnUsageRecord } from "./team-context.ts";
import type { DaemonContext } from "./types.ts";

export interface AgentUsage {
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  cacheWriteInputTokens: number;
  tokens: number;
  cacheHitRate: number;
}

export interface RunUsage {
  totalUsd: number;
  perAgent: Record<string, AgentUsage>;
  perTask: Record<string, { costUsd: number; tokens: number }>;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  cacheWriteInputTokens: number;
  tokens: number;
  cacheHitRate: number;
}

function emptyAgentUsage(): AgentUsage {
  return {
    costUsd: 0,
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 0,
    cacheWriteInputTokens: 0,
    tokens: 0,
    cacheHitRate: 0,
  };
}

export function recordTurnUsage(args: {
  team: TeamContext;
  sessionId: string;
  handle: string;
  model: string;
  usage: Usage;
  pricing?: ModelPricing;
  onSpend?: (costUsd: number) => void;
}): number {
  const costUsd = turnCostUsd(args.usage, args.pricing);
  args.team.teamCost.set(args.sessionId, (args.team.teamCost.get(args.sessionId) ?? 0) + costUsd);
  const prev = args.team.teamUsage.get(args.sessionId);
  args.team.teamUsage.set(args.sessionId, {
    handle: args.handle,
    model: args.model,
    usage: {
      inputTokens: (prev?.usage.inputTokens ?? 0) + args.usage.inputTokens,
      outputTokens: (prev?.usage.outputTokens ?? 0) + args.usage.outputTokens,
      cachedInputTokens: (prev?.usage.cachedInputTokens ?? 0) + (args.usage.cachedInputTokens ?? 0),
      cacheWriteInputTokens:
        (prev?.usage.cacheWriteInputTokens ?? 0) + (args.usage.cacheWriteInputTokens ?? 0),
    },
    costUsd: (prev?.costUsd ?? 0) + costUsd,
  });
  args.team.teamTotal.value += costUsd;
  args.onSpend?.(costUsd);
  return costUsd;
}

export function teamRunUsage(ctx: DaemonContext, parentSessionId?: string): RunUsage {
  const perAgent: Record<string, AgentUsage> = {};
  const teams =
    parentSessionId !== undefined
      ? ([ctx.teamContexts.get(parentSessionId)].filter((t) => t !== undefined) as TeamContext[])
      : [...ctx.teamContexts.values()];
  const seenSessions = new Set<string>();
  for (const team of teams) {
    for (const [sid, rec] of team.teamUsage) {
      if (seenSessions.has(sid)) continue;
      seenSessions.add(sid);
      const row = perAgent[rec.handle] ?? emptyAgentUsage();
      row.costUsd += rec.costUsd;
      row.inputTokens += rec.usage.inputTokens;
      row.outputTokens += rec.usage.outputTokens;
      row.cachedInputTokens += rec.usage.cachedInputTokens ?? 0;
      row.cacheWriteInputTokens += rec.usage.cacheWriteInputTokens ?? 0;
      perAgent[rec.handle] = row;
    }
  }
  let totalUsd = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let cachedInputTokens = 0;
  let cacheWriteInputTokens = 0;
  for (const row of Object.values(perAgent)) {
    totalUsd += row.costUsd;
    inputTokens += row.inputTokens;
    outputTokens += row.outputTokens;
    cachedInputTokens += row.cachedInputTokens;
    cacheWriteInputTokens += row.cacheWriteInputTokens;
    row.tokens = row.inputTokens + row.outputTokens;
    row.cacheHitRate = row.inputTokens > 0 ? Math.min(row.cachedInputTokens / row.inputTokens, 1) : 0;
  }
  const perTask: Record<string, { costUsd: number; tokens: number }> = {};
  // Ledger is primary; the board scan backfills tasks recorded before
  // the ledger wiring (or via direct board.recordCost callers).
  const ledger = ctx.taskLedger;
  if (ledger) Object.assign(perTask, ledger.perTask());
  for (const item of ctx.boardStore.list()) {
    if (perTask[item.id] !== undefined) continue;
    if (item.costUsd !== undefined || item.tokens !== undefined) {
      perTask[item.id] = { costUsd: item.costUsd ?? 0, tokens: item.tokens ?? 0 };
    }
  }
  const tokens = inputTokens + outputTokens;
  return {
    totalUsd,
    perAgent,
    perTask,
    inputTokens,
    outputTokens,
    cachedInputTokens,
    cacheWriteInputTokens,
    tokens,
    cacheHitRate: inputTokens > 0 ? Math.min(cachedInputTokens / inputTokens, 1) : 0,
  };
}

export interface CostMeterPayload {
  type: "cost_meter";
  sessionId: string;
  turnId?: string;
  handle?: string;
  turnCostUsd: number;
  turnTokens: number;
  turnCacheHitRate: number | null;
  runTotalUsd: number;
  runTokens: number;
  runCacheHitRate: number;
  perAgent: Record<string, number>;
}

export function costMeterFor(
  ctx: DaemonContext,
  args: {
    sessionId: string;
    turnId?: string;
    handle?: string;
    usage: Usage;
    pricing?: ModelPricing;
    parentSessionId?: string;
  },
): CostMeterPayload {
  const run = teamRunUsage(ctx, args.parentSessionId);
  const cached = args.usage.cachedInputTokens;
  const perAgent: Record<string, number> = {};
  for (const [handle, row] of Object.entries(run.perAgent)) perAgent[handle] = row.costUsd;
  return {
    type: "cost_meter",
    sessionId: args.sessionId,
    ...(args.turnId === undefined ? {} : { turnId: args.turnId }),
    ...(args.handle === undefined ? {} : { handle: args.handle }),
    turnCostUsd: turnCostUsd(args.usage, args.pricing),
    turnTokens: args.usage.inputTokens + args.usage.outputTokens,
    turnCacheHitRate:
      cached === undefined || args.usage.inputTokens <= 0
        ? null
        : Math.min(cached / args.usage.inputTokens, 1),
    runTotalUsd: run.totalUsd,
    runTokens: run.tokens,
    runCacheHitRate: run.cacheHitRate,
    perAgent,
  };
}

export type { TurnUsageRecord };

export function estimateDispatchCostFor(args: {
  agents: readonly { handle: string; brief: string; effort?: string }[];
  pricingOf: (
    handle: string,
    effort?: string,
  ) => {
    model: string;
    inputPerMTok: number;
    outputPerMTok: number;
    effort?: string;
  };
}): CostEstimate {
  const forecastAgents: DispatchAgentForecast[] = args.agents.map((a) => args.pricingOf(a.handle, a.effort));
  return estimateDispatchCost({
    briefChars: args.agents.reduce((sum, a) => sum + a.brief.length, 0),
    agents: forecastAgents,
  });
}

export function preflightDispatchEstimate(args: {
  agents: readonly { handle: string; brief: string; effort?: string }[];
  pricingOf: (
    handle: string,
    effort?: string,
  ) => {
    model: string;
    inputPerMTok: number;
    outputPerMTok: number;
    effort?: string;
  };
  ledger: SpendLedger;
  caps?: SpendCaps;
  announce?: { bus: { emit(event: string, payload: unknown): void }; sessionId: string };
}): { estimate: CostEstimate } | { refusal: string } {
  const estimate = estimateDispatchCostFor({ agents: args.agents, pricingOf: args.pricingOf });
  const gate = args.ledger.check(args.caps, estimate.lowUsd);
  if (!gate.ok) {
    if (args.announce !== undefined) {
      announceHook(args.announce.bus, "cost.threshold", {
        reason: gate.reason,
        sessionId: args.announce.sessionId,
      });
    }
    return { refusal: gate.reason };
  }
  return { estimate };
}

export function priceForModel(pricing: ModelPricing): {
  input: number;
  output: number;
  cachedInput: number;
  cacheWrite: number;
} {
  return {
    input: pricing.inputPerMTok,
    output: pricing.outputPerMTok,
    cachedInput: pricing.cachedInputPerMTok ?? pricing.inputPerMTok,
    cacheWrite: pricing.cacheWritePerMTok ?? pricing.inputPerMTok,
  };
}

// Shared pre-flight turn estimate (low USD) behind both gates below.
export function estimatePreflightTurnCostUsd(args: {
  systemPrompt: string;
  session: Message[];
  pricing?: ModelPricing;
}): number {
  const promptChars =
    args.systemPrompt.length +
    args.session.reduce(
      (sum, m) => sum + m.content.reduce((inner, b) => inner + (b.type === "text" ? b.text.length : 0), 0),
      0,
    );
  return estimateTurnCostUsd({
    promptChars,
    inputPerMTok: args.pricing?.inputPerMTok ?? 0,
    outputPerMTok: args.pricing?.outputPerMTok ?? 0,
  }).lowUsd;
}

export function assertPreflightCaps(
  ctx: DaemonContext,
  args: { sessionId: string; systemPrompt: string; session: Message[]; pricing?: ModelPricing },
): void {
  const estimateLowUsd = estimatePreflightTurnCostUsd({
    systemPrompt: args.systemPrompt,
    session: args.session,
    ...(args.pricing === undefined ? {} : { pricing: args.pricing }),
  });
  const budgets = (ctx.config as unknown as { budgets?: SpendCaps }).budgets;
  const gate = ctx.spendLedger.check(budgets, estimateLowUsd);
  if (!gate.ok) {
    announceHook(ctx.eventBus, "cost.threshold", { reason: gate.reason, sessionId: args.sessionId });
    throw new AgencyError(ErrorCode.PERMISSION_DENIED, gate.reason, { source: "spend" });
  }
  const sessionBudget = ctx.sessionBudgets.get(args.sessionId);
  if (sessionBudget?.maxCostUsd !== undefined) {
    const spent = sessionSpendUsd(ctx, args.sessionId);
    if (spent + estimateLowUsd > sessionBudget.maxCostUsd) {
      const reason = `session budget exceeded: spent $${spent.toFixed(4)} plus $${estimateLowUsd.toFixed(4)} estimate over $${sessionBudget.maxCostUsd.toFixed(4)} cap`;
      announceHook(ctx.eventBus, "cost.threshold", { reason, sessionId: args.sessionId });
      throw new AgencyError(ErrorCode.PERMISSION_DENIED, reason, { source: "spend" });
    }
  }
}

export function recordTurnCompletion(
  ctx: DaemonContext,
  args: {
    team: TeamContext;
    sessionId: string;
    handle: string;
    model: string;
    usage: Usage;
    pricing?: ModelPricing;
    turnId?: string;
    eventStreams?: string[];
    parentSessionId?: string;
    board?: BoardStore;
    taskId?: string;
  },
): number {
  const cost = recordTurnUsage({
    team: args.team,
    sessionId: args.sessionId,
    handle: args.handle,
    model: args.model,
    usage: args.usage,
    ...(args.pricing === undefined ? {} : { pricing: args.pricing }),
    onSpend: (usd) => ctx.spendLedger.record(usd),
  });
  if (args.board) {
    const claimed = args.taskId ?? args.board.list().find((item) => item.claimedBy === args.handle)?.id;
    if (claimed) args.board.recordCost(claimed, cost, args.usage.inputTokens + args.usage.outputTokens);
  }
  const ledger = ctx.taskLedger;
  if (ledger) {
    const taskId = resolveTaskId({ board: args.board, handle: args.handle, taskId: args.taskId });
    if (taskId !== undefined) {
      ledger.recordTurn(taskId, {
        usage: { inputTokens: args.usage.inputTokens, outputTokens: args.usage.outputTokens },
        costUsd: cost,
        model: args.model,
        handle: args.handle,
        ...(args.pricing === undefined ? { pricingMissing: true } : {}),
      });
    }
  }
  try {
    const meter = costMeterFor(ctx, {
      sessionId: args.sessionId,
      handle: args.handle,
      usage: args.usage,
      ...(args.turnId === undefined ? {} : { turnId: args.turnId }),
      ...(args.pricing === undefined ? {} : { pricing: args.pricing }),
      ...(args.parentSessionId === undefined ? {} : { parentSessionId: args.parentSessionId }),
    });
    for (const stream of args.eventStreams ?? []) ctx.broadcast(stream, meter);
    if (args.parentSessionId !== undefined) ctx.broadcast("team.shared", meter);
  } catch {
    return cost;
  }
  return cost;
}

export function sessionSpendUsd(ctx: DaemonContext, sessionId: string): number {
  let fromEntries = 0;
  try {
    for (const entry of ctx.todoStore.load(sessionId)) {
      if (isUsageEntry(entry)) fromEntries += (entry as unknown as { costUsd: number }).costUsd ?? 0;
    }
  } catch {
    return 0;
  }
  let fromTeams = 0;
  for (const team of ctx.teamContexts.values()) {
    fromTeams = Math.max(fromTeams, team.teamCost.get(sessionId) ?? 0);
  }
  return Math.max(fromEntries, fromTeams);
}
