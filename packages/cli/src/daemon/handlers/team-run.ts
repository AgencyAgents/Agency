import {
  announceHook,
  areScopesDisjoint,
  type BoardItem,
  checkCompletion,
  compareClaim,
  completionReport,
  decideEscalation,
  defaultTeamComposition,
  formatTeamAnnouncement,
  gateReadyForReview,
  leanBrief,
  leanSummary,
  NoProgressTracker,
  newEntryId,
  providersWithCredentials,
  type ReviewDiagnostic,
  type RunTurnResult,
  recordIntegrationCheckpoint,
  resolveRosterProviders,
  resolveScopeFiles,
  runChildTurn,
} from "@agency/core";
import { estimateDispatchCost } from "@agency/guard";
import {
  clampEffortForModel,
  classifyEffortFromText,
  type EffortLevel,
  type ModelInfo,
  resolveApiKey,
} from "@agency/providers";
import type { MethodHandler } from "@agency/rpc";
import { AgencyError, ErrorCode, type Message } from "@agency/schema";
import { extractFinalText, type SessionScope, TeamMcpPool } from "@agency/tools";
import { priceForModel, teamRunUsage } from "../costing.ts";
import { drainDigest, drainParentInbox, type TeamContext } from "../team-context.ts";
import { type DaemonContext, oauthOverridesFor, type RunTurnParams } from "../types.ts";
import { childPromptFor } from "./coords.ts";
import { createTurnApproval } from "./plan.ts";

export function initTeamRunState(ctx: DaemonContext): void {
  ctx.teamCheckpoints ??= new Map();
  ctx.teamMcpPools ??= new Map();
  installReviewGate(ctx);
  installCompletionHook(ctx);
}

// Credential-first provider resolution at team scope: roles pinned
// to a provider with no key remap to a credentialed one with a warn.
export function remapRosterToCredentials(ctx: DaemonContext): string[] {
  const { config, logger, providers } = ctx;
  const cfg = config as unknown as { agents?: Record<string, { provider?: string; model?: string }> };
  if (!cfg.agents) return [];
  const available = providersWithCredentials({ configProviders: providers, env: process.env });
  if (available.length === 0) return [];
  const { agents, remapped } = resolveRosterProviders(cfg.agents, available);
  cfg.agents = agents;
  for (const handle of remapped) {
    logger.warn(
      `agent "${handle}" remapped to provider "${agents[handle]?.provider}": no credentials for its pinned provider`,
    );
  }
  return remapped;
}

function diagnosticsForItem(ctx: DaemonContext, item: BoardItem): ReviewDiagnostic[] {
  const scopes = item.pathScope ?? [];
  if (scopes.length === 0) return [];
  let files: string[] = [];
  try {
    files = resolveScopeFiles(ctx.options.workspaceRoot, scopes);
  } catch {
    return [];
  }
  const out: ReviewDiagnostic[] = [];
  for (const abs of files) {
    for (const scope of ctx.sessionScopes.values()) {
      const registry = scope.lspRegistry;
      if (!registry) continue;
      try {
        const client = registry.clientFor(abs);
        const diags = client?.diagnosticsFor(abs) ?? [];
        for (const d of diags) {
          const rel = abs.startsWith(`${ctx.options.workspaceRoot}/`)
            ? abs.slice(ctx.options.workspaceRoot.length + 1)
            : abs;
          out.push({
            path: rel.replace(/\\/g, "/"),
            severity: d.severity,
            message: d.message,
            line: d.line,
            character: d.character,
          });
        }
      } catch {
        // One unreadable scope must not fail the gate.
      }
    }
  }
  return out;
}

// LSP diagnostics as a board gate: new errors in the item scope
// refuse ready_for_review, with per-item baselines so old debt passes.
export function installReviewGate(ctx: DaemonContext): void {
  const baseline = new Map<string, ReviewDiagnostic[]>();
  ctx.boardStore.setReviewGate((item) => {
    const current = diagnosticsForItem(ctx, item);
    const key = (d: ReviewDiagnostic): string => `${d.path}|${String(d.line)}|${d.message}`;
    const seen = new Set((baseline.get(item.id) ?? []).map(key));
    baseline.set(item.id, current);
    const fresh = current.filter((d) => !seen.has(key(d)));
    return gateReadyForReview({ item, diagnostics: fresh });
  });
}

// Completion, caps, and the no-progress detector emit the report as
// the single structured object crossing back to the lead.
export function installCompletionHook(ctx: DaemonContext): () => void {
  const tracker = new NoProgressTracker();
  const reported = new Set<string>();
  const announcedComplete = new Set<string>();
  return ctx.boardStore.addListener(() => {
    try {
      const items = ctx.boardStore.list();
      for (const item of items) {
        if (item.status === "completed" && !announcedComplete.has(item.id)) {
          announcedComplete.add(item.id);
          announceHook(ctx.eventBus, "board.item.complete", { itemId: item.id, status: item.status });
        }
      }
      const note = tracker.note(items);
      if (note === "stalled") {
        const fingerprint = items
          .map((i) => `${i.id}:${i.status}`)
          .sort()
          .join("|");
        try {
          ctx.broadcast("team.shared", { type: "team_halted", reason: "no-progress", fingerprint });
        } catch {}
        try {
          ctx.eventBus.emit("team.halted", { reason: "no-progress" });
        } catch {}
        return;
      }
      let idle = true;
      for (const team of ctx.teamContexts.values()) {
        for (const state of team.agentStates.values()) {
          if (state === "working") idle = false;
        }
      }
      const { complete, outcome } = checkCompletion(items, idle);
      if (!complete) return;
      const fingerprint = `report:${outcome}:${items
        .map((i) => `${i.id}:${i.status}`)
        .sort()
        .join("|")}`;
      if (reported.has(fingerprint)) return;
      reported.add(fingerprint);
      const run = teamRunUsage(ctx);
      const report = completionReport({
        goal: items[0]?.content ?? "team goal",
        outcome,
        items,
        decisions: ctx.choiceLog
          .list()
          .map((e) => ({ decision: e.text, proposedBy: e.proposedBy, rationale: e.rationale })),
        cost: {
          totalUsd: run.totalUsd,
          perAgent: Object.fromEntries(Object.entries(run.perAgent).map(([h, r]) => [h, r.costUsd])),
          tokens: run.tokens,
          cacheHitRate: run.cacheHitRate,
          inputTokens: run.inputTokens,
          outputTokens: run.outputTokens,
          cachedInputTokens: run.cachedInputTokens,
          cacheWriteInputTokens: run.cacheWriteInputTokens,
        },
        attempts: {},
      });
      try {
        ctx.broadcast("team.shared", { type: "team_report", report });
      } catch {}
      try {
        ctx.broadcast("team.shared", {
          type: "cost_report",
          totalUsd: run.totalUsd,
          tokens: run.tokens,
          cacheHitRate: run.cacheHitRate,
          perAgent: run.perAgent,
          perTask: run.perTask,
        });
      } catch {}
      try {
        ctx.eventBus.emit("team.report", { outcome });
      } catch {}
    } catch {
      // Hooks never break the board mutation they observe.
    }
  });
}

export function teamMcpPoolFor(ctx: DaemonContext, parentSessionId: string): TeamMcpPool | undefined {
  return ctx.teamMcpPools.get(parentSessionId);
}

// Team children share read-only/stateless MCP servers from the
// parent pool instead of starting one process set per agent.
export async function attachTeamMcpPool(
  pools: Map<string, TeamMcpPool>,
  mcpServers: unknown,
  scope: SessionScope,
  opts: { teamParent: string | undefined; handle?: string },
): Promise<void> {
  if (!opts.teamParent) return;
  const split = TeamMcpPool.split(mcpServers);
  if (Object.keys(split.shared).length === 0) return;
  let pool = pools.get(opts.teamParent);
  try {
    if (!pool) {
      pool = new TeamMcpPool(opts.teamParent, split.shared, {
        capabilities: { tools: "*", pathScopes: "*", network: "*" },
        identityFor: (_serverName, h) => ({ type: "agent", name: h ?? opts.handle ?? "main" }),
      });
      pools.set(opts.teamParent, pool);
      await pool.start();
    }
    for (const tool of pool.sharedTools()) {
      try {
        scope.registry.register(tool);
      } catch {}
    }
    (scope as { tools: Array<{ name: string }> }).tools = scope.registry.list();
    const merged = new Map<string, string>([...scope.mcpFailures, ...pool.failures()]);
    (scope as { mcpFailures: ReadonlyMap<string, string> }).mcpFailures = merged;
  } catch {
    // MCP sharing never breaks scope creation; dedicated servers still start.
  }
}

export function teamMcpDedicatedServers(mcpServers: unknown, teamParent: string | undefined): unknown {
  if (!teamParent) return mcpServers;
  return TeamMcpPool.split(mcpServers).dedicated;
}

export interface CompareChildSpec {
  team: TeamContext;
  parentSessionId: string;
  batchId: number;
  handle: string;
  prompt: string;
  leanPromptText: string;
  effort?: string;
  itemId: string;
  key: string;
  childSessionId: string;
}

export interface CompareChildResult {
  childResult?: RunTurnResult;
  childError: unknown;
  childModelInfo?: ModelInfo;
  finalText: string;
  collapsed: string;
  durationMs: number;
}

// One compare turn: prompt assembly plus the single child-turn
// run through the shared per-provider scheduler and team slots.
export async function runCompareChildTurn(
  ctx: DaemonContext,
  spec: CompareChildSpec,
): Promise<CompareChildResult> {
  const { team, handle, prompt, leanPromptText, itemId, key, childSessionId } = spec;
  const {
    adapterFor,
    boardStore,
    broadcast,
    capabilitiesForAgent,
    catalogModel,
    channelStore,
    choiceLog,
    createTraceRecorder,
    eventBus,
    gateForAgent,
    getKeychain,
    http,
    options,
    providers,
    redactor,
    schedulerFor,
    sessionScopes,
    teamRegistry,
    todoSessionsDir,
    todoStore,
    warnPersistence,
  } = ctx;
  const agent = teamRegistry.get(handle);
  if (!agent) throw new Error(`unknown handle: ${handle}`);
  compareClaim(boardStore, handle, itemId);
  const resolvedEffort =
    spec.effort ?? (agent.effort === "auto" ? classifyEffortFromText(prompt) : agent.effort);
  const childProvider = agent.provider;
  const childModel = agent.model ?? "";
  const childModelInfo = catalogModel(childProvider, childModel);
  const clampedEffort = clampEffortForModel(resolvedEffort as EffortLevel, childModelInfo);
  team.agentStates.set(key, "working");
  if (teamRegistry.list().length > 1) {
    try {
      broadcast(`team.${childSessionId}`, {
        type: "agent_lifecycle",
        handle,
        state: "working",
        detail: prompt.slice(0, 200),
        effort: clampedEffort,
      });
    } catch {}
    try {
      broadcast(`team.shared`, {
        type: "agent_lifecycle",
        handle,
        state: "working",
        detail: prompt.slice(0, 200),
        effort: clampedEffort,
      });
    } catch {}
  }
  let childApiKey = "";
  try {
    const kc = await getKeychain();
    const k = await resolveApiKey({
      provider: childProvider,
      env: process.env,
      keychain: kc,
      config: providers[childProvider]?.apiKey,
      ...oauthOverridesFor(childProvider, providers),
    });
    if (k) {
      childApiKey = k;
      redactor.registerSecret(k);
    }
  } catch {}
  const childTurnId = newEntryId();
  const startMs = Date.now();
  const freshSession: Message[] = [{ role: "user", content: [{ type: "text", text: leanBrief(prompt) }] }];
  const childScope = sessionScopes.get(childSessionId);
  const childTools = childScope?.tools ?? [];
  const agentGate = gateForAgent(handle);
  const offeredTools = childTools
    .filter((t) => agentGate.toolOffered(t.name, t.riskTier))
    .filter((t) => t.name !== "dispatch" && t.name !== "spawn");
  const agentCaps = capabilitiesForAgent(agentGate, childTools);
  const agentSystemPrompt = childPromptFor({
    goal: prompt,
    roster: teamRegistry
      .list()
      .map((m) => m.handle)
      .join(" "),
    family: agent.provider,
    role: agent.role,
    handle,
    briefLine: "Compare and respond to the given prompt concisely.",
    ...(agent.systemPrompt ? { body: agent.systemPrompt } : {}),
    replace: agent.replace ?? false,
    tools: offeredTools,
    item: prompt,
    decisions: choiceLog.digest(),
    claimed: [],
    workspaceRoot: options.workspaceRoot,
  });
  const childTurn = await team.limiter.run(() =>
    runChildTurn(
      { http, eventBus, createTraceRecorder },
      {
        adapter: adapterFor(childProvider),
        scheduler: schedulerFor(childProvider),
        session: freshSession,
        systemPrompt: agentSystemPrompt.text,
        systemSegments: agentSystemPrompt.segments,
        tools: offeredTools,
        model: childModel,
        apiKey: childApiKey,
        provider: childProvider,
        identity: { type: "agent", name: handle },
        capabilities: agentCaps,
        toolPolicy: agentGate,
        pricePerMTok: childModelInfo ? priceForModel(childModelInfo.pricing) : undefined,
        maxTokensPerRequest: childModelInfo?.maxOutputTokens,
        turnId: childTurnId,
        sessionId: childSessionId,
        cwd: options.workspaceRoot,
        taskDepth: 1,
        doomLoopDetection: true,
        drainMailbox: () => {
          const drained: Message[] = [];
          drained.push(...drainParentInbox(team, handle));
          const reg = teamRegistry.get(handle)?.mailbox;
          if (reg && reg.length > 0) {
            drained.push(...reg);
            reg.length = 0;
          }
          drained.push(...drainDigest(team, key, boardStore.listEvents(), channelStore));
          return drained;
        },
        trace: {
          sessionsDir: todoSessionsDir,
          sessionId: childSessionId,
          traceId: childTurnId,
          provider: childProvider,
          model: childModel,
        },
      },
    ),
  );
  const childResult = childTurn.result;
  const childError = childTurn.error;
  const durationMs = Date.now() - startMs;
  const finalText = childResult ? extractFinalText(childResult.messages) : "";
  const collapsed = leanSummary(
    finalText || (childError instanceof Error ? childError.message : String(childError ?? "")),
  );
  try {
    const parentLatestTip = todoStore.latestTip(todoStore.load(childSessionId)) ?? null;
    await todoStore.append(childSessionId, {
      type: "task_result",
      parentId: parentLatestTip,
      tool: "dispatch_compare",
      childSessionId,
      childTurnId,
      durationMs,
      summary: collapsed || leanSummary(finalText),
      prompt: leanPromptText,
    });
  } catch (error: unknown) {
    warnPersistence("task_result append", error);
  }
  return {
    ...(childResult ? { childResult } : {}),
    childError,
    ...(childModelInfo ? { childModelInfo } : {}),
    finalText,
    collapsed,
    durationMs,
  };
}

export function registerTeamRunHandlers(handlers: Record<string, MethodHandler>, ctx: DaemonContext): void {
  const {
    activeControllers,
    activeTurnMeta,
    boardStore,
    broadcast,
    catalogModel,
    eventBus,
    isReadOnlyAgent,
    options,
    teamContexts,
    teamFor,
    teamRegistry,
    todoStore,
    warnPersistence,
  } = ctx;

  handlers.team_open = async (rawParams) => {
    const { sessionId, goal, items, explicitRequest } = (rawParams ?? {}) as {
      sessionId?: string;
      goal?: string;
      items?: Array<{ id?: string; content?: string; pathScope?: string[]; acceptanceCriteria?: string }>;
      explicitRequest?: boolean;
    };
    const sid = typeof sessionId === "string" && sessionId.length > 0 ? sessionId : "default";
    if (typeof goal !== "string" || goal.trim().length === 0) {
      throw new AgencyError(ErrorCode.INTERNAL, "team_open requires goal", { source: "team" });
    }
    if (!Array.isArray(items) || items.length === 0) {
      throw new AgencyError(ErrorCode.INTERNAL, "team_open requires items", { source: "team" });
    }
    const decision = decideEscalation({
      itemCount: items.length,
      disjointScopes: areScopesDisjoint(items.map((i) => i.pathScope)),
      planSteps: items.length,
      explicitRequest: explicitRequest === true,
    });
    if (!decision.openTeam) return { opened: false, reason: decision.reason };
    const handles = teamRegistry.list().map((a) => a.handle);
    const composition = defaultTeamComposition({
      writers: handles.filter((h) => !isReadOnlyAgent(h)),
      reviewers: handles.filter((h) => isReadOnlyAgent(h)),
    });
    const roster = [composition.writer, ...composition.reviewers];
    const estimate = estimateDispatchCost({
      briefChars: items.reduce((sum, i) => sum + (i.content ?? "").length, 0) + goal.length,
      agents: roster.map((handle) => {
        const agent = teamRegistry.get(handle);
        const modelInfo = agent ? catalogModel(agent.provider, agent.model ?? "") : undefined;
        return {
          model: agent?.model ?? "unknown",
          inputPerMTok: modelInfo?.pricing.inputPerMTok ?? 0,
          outputPerMTok: modelInfo?.pricing.outputPerMTok ?? 0,
          effort: agent?.effort,
        };
      }),
    });
    const announcement = formatTeamAnnouncement({ handles: roster, reason: decision.reason, estimate });
    const turnId = newEntryId();
    const ask = createTurnApproval(
      ctx,
      { turnId, provider: "team", model: "team", systemPrompt: "", session: [] } as RunTurnParams,
      sid,
      "team.shared",
    );
    const verdict = await ask({
      tool: "team_open",
      title: announcement,
      metadata: { estimate, itemCount: items.length },
    });
    if (verdict === "reject") return { opened: false, reason: "team open rejected at approval" };
    const ids: string[] = [];
    items.forEach((item, index) => {
      const filed = boardStore.file(
        {
          ...(typeof item.id === "string" && item.id.length > 0
            ? { id: item.id }
            : { id: `team-${index + 1}` }),
          content: item.content ?? "",
          ...(item.acceptanceCriteria ? { acceptanceCriteria: item.acceptanceCriteria } : {}),
          ...(item.pathScope ? { pathScope: item.pathScope } : {}),
        },
        "lead",
      );
      if (!filed.ok) {
        throw new AgencyError(ErrorCode.INTERNAL, `team_open file failed: ${filed.reason}`, {
          source: "team",
        });
      }
      ids.push(filed.item.id);
    });
    try {
      const paths = resolveScopeFiles(
        options.workspaceRoot,
        items.flatMap((i) => i.pathScope ?? []),
      );
      ctx.teamCheckpoints.set(sid, recordIntegrationCheckpoint(paths));
    } catch (error: unknown) {
      warnPersistence("team checkpoint record", error);
    }
    teamFor(sid);
    try {
      broadcast("team.shared", { type: "team_open", teamId: sid, announcement, itemIds: ids, estimate });
    } catch {}
    try {
      eventBus.emit("team.open", { teamId: sid, itemIds: ids });
    } catch {}
    return { opened: true, teamId: sid, announcement, itemIds: ids, estimate };
  };

  handlers.agent_stop = async (rawParams) => {
    const { sessionId, handle } = (rawParams ?? {}) as { sessionId?: string; handle?: string };
    if (typeof handle !== "string" || handle.length === 0) {
      throw new AgencyError(ErrorCode.INTERNAL, "agent_stop requires handle", { source: "team" });
    }
    const sid = sessionId ?? "default";
    const team: TeamContext | undefined = teamContexts.get(sid);
    if (!team) return { stopped: false, reason: `no team for session ${sid}` };
    let aborted = 0;
    for (const [turnId, meta] of activeTurnMeta) {
      const child = team.sessions.get(meta.sessionId);
      if (child && child.handle === handle) {
        try {
          activeControllers.get(turnId)?.abort();
          aborted += 1;
        } catch {}
      }
    }
    for (const meta of team.sessions.values()) {
      if (meta.handle === handle) team.agentStates.set(meta.childKey, "idle");
    }
    try {
      const tip = todoStore.latestTip(todoStore.load(sid)) ?? null;
      await todoStore.append(sid, {
        type: "agent_lifecycle",
        parentId: tip,
        handle,
        state: "idle",
        detail: "agent_stop",
      });
    } catch (error: unknown) {
      warnPersistence("agent_stop lifecycle append", error);
    }
    try {
      broadcast("team.shared", { type: "agent_lifecycle", handle, state: "idle", detail: "agent_stop" });
    } catch {}
    return { stopped: true, handle, aborted };
  };
}
