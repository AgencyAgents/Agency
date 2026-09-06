import {
  type AgentFacts,
  buildEnvironmentBlock,
  buildTeamPrompt,
  buildTeamReport,
  canInspect,
  checkDelegation,
  type DelegateRequest,
  gatherEnvironmentInfo,
  INSPECT_CHARGE_USD,
  type InspectableSpan,
  inspectReasoning,
  inspectStep,
  inspectTimeline,
  isTeamLive,
  LEAD_WITHHELD_TOOLS,
  loadTraceSpansSync,
  materializeDelegate,
  spansToInspectable,
  type TeamPrompt,
} from "@agency/core";
import type { SessionScope } from "@agency/tools";
import type { DaemonContext } from "../types.ts";

export function factsForHandle(ctx: DaemonContext, handle: string): AgentFacts | undefined {
  const agent = ctx.teamRegistry.get(handle);
  if (!agent) return undefined;
  const agentTools = agent.tools ?? "*";
  const modelInfo = agent.model ? ctx.catalogModel(agent.provider, agent.model) : undefined;
  let inFlight = 0;
  for (const team of ctx.teamContexts.values()) {
    for (const meta of team.sessions.values()) {
      if (meta.handle === handle && team.agentStates.get(meta.childKey) === "working") inFlight += 1;
    }
  }
  return {
    handle,
    capabilities: [agent.role, ...(Array.isArray(agentTools) ? agentTools : [])],
    tools: agentTools,
    priceIndex: modelInfo ? modelInfo.pricing.inputPerMTok + modelInfo.pricing.outputPerMTok : 1,
    inFlight,
  };
}

export function costForTeam(ctx: DaemonContext): {
  totalUsd: number;
  perAgent: Record<string, number>;
  tokens: number;
} {
  const perAgent: Record<string, number> = {};
  let totalUsd = 0;
  for (const team of ctx.teamContexts.values()) {
    for (const [sid, usd] of team.teamCost) {
      const handle = team.sessions.get(sid)?.handle ?? sid;
      perAgent[handle] = (perAgent[handle] ?? 0) + usd;
      totalUsd += usd;
    }
  }
  return { totalUsd, perAgent, tokens: 0 };
}

export function spansForHandle(ctx: DaemonContext, handle: string): InspectableSpan[] {
  let best: string | undefined;
  let bestBatch = -1;
  for (const team of ctx.teamContexts.values()) {
    for (const [sid, meta] of team.sessions) {
      if (meta.handle === handle && meta.batchId > bestBatch) {
        best = sid;
        bestBatch = meta.batchId;
      }
    }
  }
  const sid = best ?? ctx.teamRegistry.get(handle)?.sessionId;
  if (!sid) return [];
  try {
    return spansToInspectable(loadTraceSpansSync(ctx.todoSessionsDir, sid));
  } catch {
    return [];
  }
}

export function grantsForHandle(
  ctx: DaemonContext,
  handle: string,
): { pathScope?: readonly string[] | "*"; tools?: readonly string[] | "*" } {
  const agentCfg = (
    ctx.config as unknown as { agents?: Record<string, { pathScope?: string[]; tools?: string[] }> }
  ).agents?.[handle];
  return {
    pathScope: agentCfg?.pathScope ?? ("*" as const),
    tools: agentCfg?.tools ?? ("*" as const),
  };
}

export function childPromptFor(args: {
  goal: string;
  roster: string;
  family: string;
  role: string;
  handle: string;
  briefLine: string;
  body?: string;
  replace?: boolean;
  tools: Array<{ name: string; description: string }>;
  item: string;
  decisions: string[];
  claimed: string[];
  workspaceRoot: string;
}): TeamPrompt {
  return buildTeamPrompt({
    goal: args.goal,
    roster: args.roster,
    ownersSummary: "(see owners_read)",
    workspaceTexts: [],
    family: args.family,
    role: args.role,
    builtInRolePrompt: `You are ${args.handle}, a ${args.role} agent. ${args.briefLine}`,
    ...(args.body ? { agentBody: args.body } : {}),
    replaceRole: args.replace ?? false,
    toolDescriptions: args.tools.map((t) => `${t.name}: ${t.description}`),
    itemContract: args.item,
    decisions: args.decisions,
    claimedItems: args.claimed,
    inbox: [],
    digest: [],
    environment: buildEnvironmentBlock(gatherEnvironmentInfo({ cwd: args.workspaceRoot })),
  });
}

// Per-scope board tools: read, claim, status, file, and owners,
// gated by the owning agent's permission map.
export async function registerBoardToolsForScope(
  scope: SessionScope,
  ctx: DaemonContext,
  ownerHandle: string | undefined,
  handle: string | undefined,
): Promise<void> {
  const { createBoardTools } = await import("@agency/tools");
  const filerHandle = ownerHandle ?? handle ?? "lead";
  const filerGate = filerHandle === "lead" ? ctx.gate : ctx.gateForAgent(filerHandle);
  const filerCfg = (
    ctx.config as unknown as {
      agents?: Record<string, { pathScope?: string[]; tools?: string[] }>;
      budgets?: { perAgentUsd?: number };
    }
  ).agents?.[filerHandle];
  const filerBudgets = (ctx.config as unknown as { budgets?: { perAgentUsd?: number } }).budgets;
  const boardTools = createBoardTools({
    backend: ctx.boardStore,
    resolveFiler: () => ({
      handle: filerHandle,
      grants: {
        pathScope: filerCfg?.pathScope ?? "*",
        tools: filerCfg?.tools ?? "*",
        ...(filerBudgets?.perAgentUsd === undefined ? {} : { budgetUsd: filerBudgets.perAgentUsd }),
      },
    }),
    allowed: (tool) =>
      filerGate.toolOffered(tool, tool === "board_read" || tool === "owners_read" ? "safe" : "moderate"),
    workspaceRoot: ctx.options.workspaceRoot,
  });
  for (const t of boardTools) {
    if (!scope.registry.has(t.name)) scope.registry.register(t);
  }
  (scope as unknown as { tools: Array<{ name: string }> }).tools = scope.registry.list();
}

// Per-scope coord tools: delegate, inbox, channel, decisions,
// lead-only inspection, and the structured report getter.
export async function registerCoordToolsForScope(
  scope: SessionScope,
  ctx: DaemonContext,
  filerHandle: string,
): Promise<void> {
  const { createCoordTools } = await import("@agency/tools");
  const coordGate = filerHandle === "lead" ? ctx.gate : ctx.gateForAgent(filerHandle);
  const coordTools = createCoordTools({
    board: ctx.boardStore,
    inbox: ctx.inboxStore,
    channel: ctx.channelStore,
    choices: ctx.choiceLog,
    resolveFiler: () => ({ handle: filerHandle, isLead: filerHandle === "lead" }),
    factsOf: (h) => factsForHandle(ctx, h),
    allFacts: () =>
      ctx.teamRegistry
        .list()
        .map((a) => factsForHandle(ctx, a.handle))
        .filter((f): f is AgentFacts => f !== undefined),
    grantsOf: (h) => grantsForHandle(ctx, h),
    decide: (facts, req, all) => {
      const verdict = checkDelegation(facts, req, all);
      return verdict.delegate
        ? { delegate: true, handle: verdict.handle, reason: verdict.reason }
        : { delegate: false, reason: verdict.reason };
    },
    fileDelegated: (filedBy, req, target, grants) => {
      const input: DelegateRequest = { brief: req.brief ?? "" };
      if (req.to !== undefined) input.to = req.to;
      if (req.needs !== undefined) input.needs = [...req.needs];
      const filed = materializeDelegate(ctx.boardStore, filedBy, input, target, grants);
      if (!filed.ok) return { ok: false, reason: filed.reason };
      return { ok: true, id: filed.filed.item.id };
    },
    buildReport: (outcome) => {
      const items = ctx.boardStore.list().map((item) => ({
        id: item.id,
        content: item.content,
        status: item.status,
        ...(item.claimedBy === undefined ? {} : { claimedBy: item.claimedBy }),
        ...(item.filedBy === undefined ? {} : { filedBy: item.filedBy }),
      }));
      const cost = costForTeam(ctx);
      return buildTeamReport({
        goal: ctx.boardStore.list()[0]?.content ?? "team goal",
        outcome:
          outcome === "halted" || outcome === "over-budget" || outcome === "needs-user"
            ? outcome
            : "complete",
        items,
        decisions: ctx.choiceLog
          .list()
          .map((e) => ({ decision: e.text, proposedBy: e.proposedBy, rationale: e.rationale })),
        openQuestions: [],
        cost: { ...cost, cacheHitRate: 0 },
        attempts: {},
      });
    },
    spansOf: (h) => spansForHandle(ctx, h),
    itemsOf: (h) =>
      ctx.boardStore
        .list()
        .filter((i) => i.claimedBy === h || i.filedBy === h)
        .map((i) => i.id),
    mayInspect: (args) => canInspect(args),
    timeline: (spans, filter) =>
      inspectTimeline(spans, {
        ...(filter.since === undefined ? {} : { since: filter.since }),
        ...(filter.limit === undefined ? {} : { limit: filter.limit }),
        ...(filter.where === "errors" || filter.where === "writes" ? { where: filter.where } : {}),
      }),
    stepDetail: (spans, step) => inspectStep(spans, step) ?? undefined,
    reasoning: (spans, from, to) => inspectReasoning(spans, from, to),
    inspectCharge: INSPECT_CHARGE_USD,
    inspectTokens: (text) => Math.ceil(text.length / 4),
    allowed: (tool) => {
      if (tool === "agent_inspect") return filerHandle === "lead";
      return coordGate.toolOffered(
        tool,
        tool === "channel_read" || tool === "report_get" ? "safe" : "moderate",
      );
    },
  });
  for (const t of coordTools) {
    if (!scope.registry.has(t.name)) scope.registry.register(t);
  }
  (scope as unknown as { tools: Array<{ name: string }> }).tools = scope.registry.list();
}

// While board items are open the lead coordinates only: write,
// edit, and bash leave the offered set until the team closes.
export function demoteScopeForLead<T extends { name: string }>(
  tools: readonly T[],
  filerHandle: string,
  live: boolean,
): T[] {
  if (filerHandle !== "lead" || !live) return [...tools];
  const withheld = new Set<string>(LEAD_WITHHELD_TOOLS);
  return tools.filter((t) => !withheld.has(t.name));
}

export function boardIsLive(ctx: DaemonContext): boolean {
  return isTeamLive(ctx.boardStore.list());
}
