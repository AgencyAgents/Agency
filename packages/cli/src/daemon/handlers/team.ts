import {
  type AgentConfig,
  type FileAgentDef,
  isValidAgentHandle,
  leanPrompt,
  leanSummary,
  openCompareItem,
  type PluginAgentContribution,
  recordCompareVerdict,
  resolveFileRoster,
  spawnParallel,
} from "@agency/core";
import { clampEffortForModel, resolveApiKey } from "@agency/providers";
import type { MethodHandler } from "@agency/rpc";
import { AgencyError, ErrorCode, type Message } from "@agency/schema";
import { recordTurnCompletion } from "../costing.ts";
import {
  agentsListPayload,
  childKey,
  childSessionIdFor,
  costUsdForHandle,
  latestChildAnywhere,
  latestChildSession,
} from "../team-context.ts";
import { type DaemonContext, oauthOverridesFor } from "../types.ts";
import { type CompareChildResult, runCompareChildTurn } from "./team-run.ts";

type FileBackedAgent = AgentConfig & {
  systemPrompt?: string;
  replace?: boolean;
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
        ...(def.replace !== undefined ? { replace: def.replace } : {}),
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
        ...(a.replace !== undefined ? { replace: a.replace } : {}),
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
    approvalManagers,
    boardStore,
    broadcast,
    config,
    eventBus,
    getKeychain,
    getOrCreateScope,
    logger,
    providers,
    redactor,
    sessionScopes,
    teamContexts,
    teamFor,
    teamRegistry,
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
    // Compare team mode: one shared board item with N non-exclusive
    // claims, so the comparison is durable and the verdict is recorded.
    const opened = openCompareItem(boardStore, {
      prompt: leanPromptText,
      handles,
      filedBy: "lead",
      id: `compare-${parentSessionId}-${batchId}`,
    });
    const itemId = opened.ok ? opened.itemId : `compare-${parentSessionId}-${batchId}`;
    // Pre-resolve one key per provider: empty string is a miss so every
    // child in the batch skips the per-child keychain fallback.
    const compareKeys = new Map<string, string>();
    try {
      const kc = await getKeychain().catch(() => undefined);
      const needed = new Set<string>();
      for (const handle of handles) {
        const provider = teamRegistry.get(handle)?.provider;
        if (provider) needed.add(provider);
      }
      for (const provider of needed) {
        const found = await resolveApiKey({
          provider,
          env: process.env,
          keychain: kc ?? undefined,
          config: providers[provider]?.apiKey,
          ...oauthOverridesFor(provider, providers),
        });
        if (found) {
          compareKeys.set(provider, found);
          redactor.registerSecret(found);
        } else {
          compareKeys.set(provider, "");
        }
      }
    } catch {}
    const okBy = new Map<string, boolean>();
    const { results } = await spawnParallel(
      handles,
      async (handle): Promise<{ handle: string; result: string }> => {
        const agent = teamRegistry.get(handle);
        if (!agent) {
          okBy.set(handle, false);
          return { handle, result: `unknown handle: ${handle}` };
        }
        const compareBudgets = (config as unknown as { budgets?: { perAgentUsd?: number; teamUsd?: number } })
          .budgets;
        if (compareBudgets?.teamUsd !== undefined && team.teamTotal.value >= compareBudgets.teamUsd) {
          okBy.set(handle, false);
          return {
            handle,
            result: `${handle}: team budget exceeded: ${team.teamTotal.value} >= ${compareBudgets.teamUsd}`,
          };
        }
        const spentForHandle = costUsdForHandle(ctx, handle);
        if (compareBudgets?.perAgentUsd !== undefined && spentForHandle >= compareBudgets.perAgentUsd) {
          okBy.set(handle, false);
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
        let outcome: CompareChildResult;
        const preResolved = compareKeys.get(agent.provider);
        try {
          outcome = await runCompareChildTurn(ctx, {
            team,
            parentSessionId,
            batchId,
            handle,
            prompt,
            leanPromptText,
            ...(effort === undefined ? {} : { effort }),
            ...(preResolved === undefined ? {} : { apiKey: preResolved }),
            itemId,
            key,
            childSessionId,
          });
        } catch (error: unknown) {
          okBy.set(handle, false);
          return {
            handle,
            result: `${handle}: ${error instanceof Error ? error.message : String(error)}`,
          };
        }
        const { childResult, childError, childModelInfo, finalText } = outcome;

        if (childResult && childModelInfo) {
          const childCost = recordTurnCompletion(ctx, {
            team,
            sessionId: childSessionId,
            handle,
            model: agent.model ?? "",
            usage: childResult.usage,
            pricing: childModelInfo.pricing,
            eventStreams: [`team.${childSessionId}`],
            parentSessionId,
          });
          boardStore.recordCost(
            itemId,
            childCost,
            childResult.usage.inputTokens + childResult.usage.outputTokens,
          );
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
          okBy.set(handle, false);
          return {
            handle,
            result: `${handle}: ${childError instanceof Error ? childError.message : String(childError)}`,
          };
        }
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
        okBy.set(handle, true);
        return {
          handle,
          result: `${handle} (${agent.provider}/${agent.model}) · ${leanSummary(finalText, 120) || "(no output)"}`,
        };
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
    const winner = handles.find((h) => okBy.get(h) === true) ?? "none";
    recordCompareVerdict(boardStore, {
      itemId,
      by: "lead",
      winner,
      rationale:
        winner === "none"
          ? "all comparers failed"
          : `${winner} completed first among ${String(handles.length)}`,
    });
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
