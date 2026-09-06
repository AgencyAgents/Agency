import {
  type AgentConfig,
  buildEnvironmentBlock,
  composeSystemPrompt,
  type FileAgentDef,
  gatherEnvironmentInfo,
  isValidAgentHandle,
  leanBrief,
  leanPrompt,
  leanSummary,
  newEntryId,
  type PluginAgentContribution,
  resolveFileRoster,
  runChildTurn,
  spawnParallel,
} from "@agency/core";
import { clampEffortForModel, classifyEffortFromText, resolveApiKey, Scheduler } from "@agency/providers";
import type { MethodHandler } from "@agency/rpc";
import { AgencyError, ErrorCode, type Message } from "@agency/schema";
import { extractFinalText } from "@agency/tools";
import {
  agentsListPayload,
  childKey,
  childSessionIdFor,
  costUsdForHandle,
  drainParentInbox,
  latestChildAnywhere,
  latestChildSession,
} from "../team-context.ts";
import { type DaemonContext, oauthOverridesFor } from "../types.ts";

type FileBackedAgent = AgentConfig & {
  systemPrompt?: string;
  tools?: string[];
  pathScope?: string[];
};

export function initTeamFromConfig(ctx: DaemonContext): void {
  const { catalogModel, config, logger, resolveAgentModel, teamRegistry } = ctx;
  const cfg = config as unknown as {
    agents?: Record<string, FileBackedAgent>;
    leader?: string;
  };
  // File roster wins over config: project files, then user files, then config.
  let fileAgents = new Map<string, FileAgentDef>();
  try {
    const roster = resolveFileRoster({
      workspaceRoot: ctx.options.workspaceRoot,
      ...(ctx.options.configDir !== undefined ? { configDirOverride: ctx.options.configDir } : {}),
      ...(cfg.agents !== undefined ? { configAgents: cfg.agents } : {}),
    });
    fileAgents = roster.agents;
    const merged: Record<string, FileBackedAgent> = { ...(cfg.agents ?? {}) };
    for (const [handle, def] of fileAgents) {
      const prev = merged[handle] ?? { role: def.role };
      merged[handle] = {
        ...prev,
        role: def.role,
        ...(def.provider !== undefined ? { provider: def.provider } : {}),
        ...(def.model !== undefined ? { model: def.model } : {}),
        ...(def.effort !== undefined ? { effort: def.effort as FileBackedAgent["effort"] } : {}),
        ...(def.permissions !== undefined
          ? { permissions: def.permissions as FileBackedAgent["permissions"] }
          : {}),
        ...(def.systemPrompt.length > 0 ? { systemPrompt: def.systemPrompt } : {}),
        ...(def.tools !== undefined ? { tools: def.tools } : {}),
        ...(def.pathScope !== undefined ? { pathScope: def.pathScope } : {}),
      };
    }
    cfg.agents = merged;
  } catch (err) {
    logger.warn(`agent files unreadable, falling back to config roster: ${String(err)}`);
  }
  // Plugin-contributed agents fill handles the file roster did not define.
  const pluginAgents: Array<{ pluginId: string; agent: PluginAgentContribution }> = ctx.pluginAgents ?? [];
  for (const { agent } of pluginAgents) {
    const handle = agent.handle ?? agent.role;
    if (!isValidAgentHandle(handle)) {
      logger.warn(`plugin agent handle "${handle}" must match [a-z][a-z0-9-]*, skipping`);
      continue;
    }
    if (cfg.agents?.[handle] !== undefined || teamRegistry.has(handle)) continue;
    cfg.agents ??= {};
    cfg.agents[handle] = {
      role: agent.role,
      ...(agent.provider !== undefined ? { provider: agent.provider } : {}),
      ...(agent.model !== undefined ? { model: agent.model } : {}),
      ...(agent.effort !== undefined ? { effort: agent.effort as FileBackedAgent["effort"] } : {}),
      ...(agent.permissions !== undefined
        ? { permissions: agent.permissions as FileBackedAgent["permissions"] }
        : {}),
      ...((agent.prompt ?? "").length > 0 ? { systemPrompt: agent.prompt as string } : {}),
      ...(agent.tools !== undefined ? { tools: agent.tools } : {}),
      ...(agent.pathScope !== undefined
        ? { pathScope: Array.isArray(agent.pathScope) ? agent.pathScope : [agent.pathScope] }
        : {}),
    };
  }
  if (!cfg.agents) return;
  for (const [handle, a] of Object.entries(cfg.agents)) {
    // Skip disabled agents: they are not registered in the team
    if (a.enabled === false) continue;
    // Skip enabled agents that are missing required fields
    if (!a.provider) {
      logger.warn(
        `agent "${handle}" is enabled but missing provider: configure provider/model/effort before use`,
      );
      continue;
    }
    if (!a.effort) {
      logger.warn(
        `agent "${handle}" is enabled but missing effort: configure provider/model/effort before use`,
      );
      continue;
    }
    if (!teamRegistry.has(handle)) {
      const resolvedModel = resolveAgentModel(a.provider, a.model);
      const modelInfo = catalogModel(a.provider, resolvedModel);
      const clampedEffort = clampEffortForModel(
        a.effort as import("@agency/providers").EffortLevel,
        modelInfo,
      );
      teamRegistry.register({
        handle,
        role: a.role,
        provider: a.provider,
        model: resolvedModel,
        effort: clampedEffort,
        sessionId: `team-${handle}`,
        mailbox: [],
        ...(a.systemPrompt !== undefined && a.systemPrompt.length > 0
          ? { systemPrompt: a.systemPrompt }
          : {}),
        ...(a.tools !== undefined ? { tools: a.tools } : {}),
        ...(a.pathScope !== undefined ? { pathScope: a.pathScope } : {}),
      });
    }
  }
  // Enforce leader must be enabled
  if (!teamRegistry.has("leader")) {
    logger.warn("leader agent is disabled or missing: leader must be enabled for team operations");
  }
  // Enforce at least one enabled agent
  if (teamRegistry.list().length === 0) {
    logger.warn("no agents enabled: enable at least one agent (leader is required)");
  }
}

export function registerTeamHandlers(handlers: Record<string, MethodHandler>, ctx: DaemonContext): void {
  const {
    activeControllers,
    adapterFor,
    approvalManagers,
    boardStore,
    broadcast,
    capabilitiesForAgent,
    catalogModel,
    config,
    createTraceRecorder,
    eventBus,
    gateForAgent,
    getKeychain,
    getOrCreateScope,
    http,
    logger,
    options,
    providers,
    redactor,
    sessionScopes,
    teamContexts,
    teamFor,
    teamRegistry,
    todoSessionsDir,
    todoStore,
    warnPersistence,
  } = ctx;
  handlers.approval_respond = async (rawParams) => {
    const { requestId, decision, sessionId } = rawParams as {
      requestId: string;
      decision: "once" | "always" | "reject";
      sessionId?: string;
    };
    if (decision !== "once" && decision !== "always" && decision !== "reject") {
      throw new AgencyError(ErrorCode.INTERNAL, `invalid approval decision: ${String(decision)}`, {
        source: "approval",
      });
    }
    const managers = sessionId ? [approvalManagers.get(sessionId)] : [...approvalManagers.values()];
    for (const manager of managers) {
      const outcome = manager?.respond(requestId, decision);
      if (outcome?.resolved) return outcome;
    }
    return { resolved: false, retroactive: 0 };
  };
  handlers.agent_message = async (rawParams) => {
    const { from, to, body, sessionId } = rawParams as {
      from: string;
      to: string;
      body: string;
      sessionId?: string;
    };
    const sid = sessionId ?? "default";
    const entrySid = sid;
    try {
      const tip = todoStore.latestTip(todoStore.load(entrySid)) ?? null;
      await todoStore.append(entrySid, { type: "agent_message", parentId: tip, from, to, body });
    } catch (error: unknown) {
      warnPersistence("agent_message append", error);
    }
    const box: Message = { role: "user", content: [{ type: "text", text: `[from ${from}] ${body}` }] };
    if (sessionId !== undefined) {
      // Scoped delivery: only this parent's latest child for `to` sees
      // it, so sibling parents dispatching the same handle stay deaf.
      const team = teamContexts.get(sessionId);
      const childSid = team ? latestChildSession(team, to) : undefined;
      const meta = childSid ? team?.sessions.get(childSid) : undefined;
      if (team && meta) {
        const inbox = team.agentInboxes.get(meta.childKey) ?? [];
        team.agentInboxes.set(meta.childKey, inbox);
        inbox.push(box);
      } else {
        const mbox = teamRegistry.get(to)?.mailbox;
        if (mbox) mbox.push(box);
      }
    } else {
      const mbox = teamRegistry.get(to)?.mailbox;
      if (mbox) mbox.push(box);
    }
    try {
      eventBus.emit("agent.message", { from, to, body });
    } catch {}
    return { delivered: true };
  };
  handlers.agents_list = async (rawParams) => {
    const { sessionId } = (rawParams ?? {}) as { sessionId?: string };
    return agentsListPayload(ctx, sessionId);
  };
  handlers.agent_history = async (rawParams) => {
    const { handle, sessionId } = rawParams as { handle: string; sessionId?: string };
    if (typeof handle !== "string" || handle.length === 0) {
      throw new AgencyError(ErrorCode.INTERNAL, "agent_history requires handle", { source: "team" });
    }
    const agent = teamRegistry.get(handle);
    if (!agent) {
      throw new AgencyError(ErrorCode.INTERNAL, `unknown handle: ${handle}`, { source: "team" });
    }
    const team = sessionId !== undefined ? teamContexts.get(sessionId) : undefined;
    const sid =
      (team ? latestChildSession(team, handle) : undefined) ??
      (sessionId === undefined ? latestChildAnywhere(ctx, handle) : undefined) ??
      agent.sessionId;
    const entries = todoStore.load(sid);
    const tip = todoStore.latestTip(entries) ?? null;
    const messages = tip ? todoStore.messagesFor(entries, tip) : [];
    return { handle, sessionId: sid, entries, messages };
  };
  handlers.team_status = async (rawParams) => {
    const { sessionId } = (rawParams ?? {}) as { sessionId?: string };
    const agents = agentsListPayload(ctx, sessionId);
    const todo = boardStore.list();
    const costTotal = agents.reduce((sum, a) => sum + (a.costUsd ?? 0), 0);
    return { agents, todo, costTotal };
  };
  handlers.dispatch_compare = async (rawParams) => {
    const { handles, prompt, effort, sessionId } = rawParams as {
      handles: string[];
      prompt: string;
      effort?: string;
      sessionId?: string;
    };
    if (!Array.isArray(handles) || handles.length === 0) {
      throw new AgencyError(ErrorCode.INTERNAL, "dispatch_compare requires handles", {
        source: "team",
      });
    }
    if (typeof prompt !== "string" || prompt.trim().length === 0) {
      throw new AgencyError(ErrorCode.INTERNAL, "dispatch_compare requires prompt", {
        source: "team",
      });
    }
    const parentSessionId = sessionId ?? "default";
    const team = teamFor(parentSessionId);
    const batchId = team.nextBatchId++;
    const leanPromptText = leanPrompt(prompt);
    try {
      broadcast(`team.shared`, { type: "dispatch_compare_start", count: handles.length, handles });
    } catch {}
    const compareScheduler = new Scheduler({ maxConcurrent: Math.max(8, handles.length) });
    const { results } = await spawnParallel(
      handles,
      async (handle): Promise<{ handle: string; result: string }> => {
        const agent = teamRegistry.get(handle);
        if (!agent) {
          return { handle, result: `unknown handle: ${handle}` };
        }
        const compareBudgets = (config as unknown as { budgets?: { perAgentUsd?: number; teamUsd?: number } })
          .budgets;
        if (compareBudgets?.teamUsd !== undefined && team.teamTotal.value >= compareBudgets.teamUsd) {
          return {
            handle,
            result: `${handle}: team budget exceeded: ${team.teamTotal.value} >= ${compareBudgets.teamUsd}`,
          };
        }
        const spentForHandle = costUsdForHandle(ctx, handle);
        if (compareBudgets?.perAgentUsd !== undefined && spentForHandle >= compareBudgets.perAgentUsd) {
          return {
            handle,
            result: `${handle}: budget exceeded: per-agent ${spentForHandle} >= ${compareBudgets.perAgentUsd}`,
          };
        }
        const key = childKey(parentSessionId, handle, batchId);
        const childSessionId = childSessionIdFor(parentSessionId, handle, batchId);
        team.sessions.set(childSessionId, { handle, batchId, childKey: key });
        try {
          todoStore.create(childSessionId);
        } catch (error: unknown) {
          warnPersistence("todoStore.create", error);
        }
        await getOrCreateScope(childSessionId, handle);
        const compareScope = sessionScopes.get(childSessionId);
        if (compareScope) compareScope.teamId = parentSessionId;
        const resolvedEffort =
          effort ?? (agent.effort === "auto" ? classifyEffortFromText(prompt) : agent.effort);
        // --- Real turn execution (concurrent per handle) ---
        const childProvider = agent.provider;
        const childModel = agent.model ?? "";
        const childModelInfo = catalogModel(childProvider, childModel);
        const clampedEffort = clampEffortForModel(
          resolvedEffort as import("@agency/providers").EffortLevel,
          childModelInfo,
        );
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

        const freshSession: Message[] = [
          { role: "user", content: [{ type: "text", text: leanBrief(prompt) }] },
        ];

        const childScope = sessionScopes.get(childSessionId);
        const childTools = childScope?.tools ?? [];
        const agentGate = gateForAgent(handle);
        const offeredTools = childTools
          .filter((t) => agentGate.toolOffered(t.name, t.riskTier))
          // Depth-0 child isolation: subagents cannot dispatch or spawn.
          .filter((t) => t.name !== "dispatch" && t.name !== "spawn");
        const agentCaps = capabilitiesForAgent(agentGate, childTools);

        const agentSystemPrompt = composeSystemPrompt({
          base:
            agent.systemPrompt && agent.systemPrompt.length > 0
              ? agent.systemPrompt
              : `You are ${handle}, a ${agent.role} agent. Compare and respond to the given prompt concisely.`,
          familyPresetOverlay: undefined,
          instructions: [],
          toolDescriptions: [],
          context: buildEnvironmentBlock(gatherEnvironmentInfo({ cwd: options.workspaceRoot })),
        });

        const childTurn = await runChildTurn(
          { http, eventBus, createTraceRecorder },
          {
            adapter: adapterFor(childProvider),
            scheduler: compareScheduler,
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
            pricePerMTok: childModelInfo
              ? { input: childModelInfo.pricing.inputPerMTok, output: childModelInfo.pricing.outputPerMTok }
              : undefined,
            maxTokensPerRequest: childModelInfo?.maxOutputTokens,
            turnId: childTurnId,
            sessionId: childSessionId,
            cwd: options.workspaceRoot,
            taskDepth: 1,
            doomLoopDetection: true,
            drainMailbox: () => {
              const drained: import("@agency/schema").Message[] = [];
              drained.push(...drainParentInbox(team, handle));
              const reg = teamRegistry.get(handle)?.mailbox;
              if (reg && reg.length > 0) {
                drained.push(...reg);
                reg.length = 0;
              }
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
        );
        const childResult = childTurn.result;
        const childError = childTurn.error;

        if (childResult && childModelInfo) {
          const costUsd =
            (childResult.usage.inputTokens / 1_000_000) * childModelInfo.pricing.inputPerMTok +
            (childResult.usage.outputTokens / 1_000_000) * childModelInfo.pricing.outputPerMTok;
          team.teamCost.set(childSessionId, (team.teamCost.get(childSessionId) ?? 0) + costUsd);
          team.teamTotal.value += costUsd;
        }

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

        if (childError) {
          team.agentStates.set(key, "failed");
          try {
            const tip2 = todoStore.latestTip(todoStore.load(childSessionId)) ?? null;
            await todoStore
              .append(childSessionId, {
                type: "agent_lifecycle",
                parentId: tip2,
                handle,
                state: "failed",
                detail: childError instanceof Error ? childError.message : String(childError),
              })
              .catch((error: unknown) => {
                warnPersistence("agent_lifecycle append", error);
              });
          } catch (error: unknown) {
            warnPersistence("agent_lifecycle load", error);
          }
          if (teamRegistry.list().length > 1) {
            try {
              broadcast(`team.${childSessionId}`, {
                type: "agent_lifecycle",
                handle,
                state: "failed",
              });
            } catch {}
            try {
              broadcast(`team.shared`, { type: "agent_lifecycle", handle, state: "failed" });
            } catch {}
          }
          return {
            handle,
            result: `${handle}: ${childError instanceof Error ? childError.message : String(childError)}`,
          };
        } else {
          team.agentStates.set(key, "idle");
          try {
            const tip2 = todoStore.latestTip(todoStore.load(childSessionId)) ?? null;
            await todoStore
              .append(childSessionId, {
                type: "agent_lifecycle",
                parentId: tip2,
                handle,
                state: "idle",
                detail: "compare done",
              })
              .catch((error: unknown) => {
                warnPersistence("agent_lifecycle append", error);
              });
          } catch (error: unknown) {
            warnPersistence("agent_lifecycle load", error);
          }
          if (teamRegistry.list().length > 1) {
            try {
              broadcast(`team.${childSessionId}`, { type: "agent_lifecycle", handle, state: "idle" });
            } catch {}
            try {
              broadcast(`team.shared`, { type: "agent_lifecycle", handle, state: "idle" });
            } catch {}
          }
          return {
            handle,
            result: `${handle} (${agent.provider}/${agent.model}) · ${leanSummary(finalText, 120) || "(no output)"}`,
          };
        }
      },
      {
        onSettle: (settled) => {
          try {
            eventBus.emit("dispatch.compare.complete", { count: settled.length });
          } catch {}
          try {
            broadcast(`team.shared`, { type: "dispatch_compare_complete", count: settled.length });
          } catch {}
        },
      },
    );
    try {
      eventBus.emit("dispatch.compare", { handles, prompt: leanPromptText });
    } catch {}
    return { results };
  };
  handlers.team_stop = async (rawParams: unknown) => {
    const { sessionId } = (rawParams ?? {}) as { sessionId?: string };
    const sid = sessionId ?? "default";
    for (const ctrl of activeControllers.values())
      try {
        ctrl.abort();
      } catch {}
    try {
      const tip = todoStore.latestTip(todoStore.load(sid)) ?? null;
      for (const h of teamRegistry.list().map((a) => a.handle)) {
        await todoStore
          .append(sid, {
            type: "agent_lifecycle",
            parentId: tip,
            handle: h,
            state: "idle",
            detail: "team_stop",
          })
          .catch((error: unknown) => {
            logger.warn("team_stop lifecycle append failed", {
              sessionId: sid,
              error: error instanceof Error ? error.message : String(error),
            });
          });
        const team = teamContexts.get(sid);
        if (team) {
          for (const stateKey of team.agentStates.keys()) team.agentStates.set(stateKey, "idle");
        }
        if (teamRegistry.list().length > 1) {
          const agent = teamRegistry.get(h);
          const stream = agent ? `team.${agent.sessionId}` : `team.${sid}`;
          try {
            broadcast(stream, { type: "agent_lifecycle", handle: h, state: "idle" });
          } catch {}
          try {
            broadcast(`team.shared`, { type: "agent_lifecycle", handle: h, state: "idle" });
          } catch {}
        }
      }
    } catch (error: unknown) {
      warnPersistence("team_stop load", error);
    }
    return { stopped: true };
  };
}
