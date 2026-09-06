import { join } from "node:path";
import {
  buildEnvironmentBlock,
  composeSystemPrompt,
  createDispatchTool,
  createWorktree,
  formatSkipLine,
  gatherEnvironmentInfo,
  leanBrief,
  leanPrompt,
  leanSummary,
  makeWorktreeReadOnly,
  newEntryId,
  PromiseBarrier,
  resolveDispatchTarget,
  runChildTurn,
  type ToolSpec,
} from "@agency/core";
import { checkCostForecast, type DispatchAgentForecast, estimateDispatchCost } from "@agency/guard";
import { classifyEffortFromText, resolveApiKey, Scheduler } from "@agency/providers";
import type { Message } from "@agency/schema";
import { extractFinalText } from "@agency/tools";
import { checkTeamBudgets, type DaemonContext, oauthOverridesFor, type TeamBudgets } from "../types.ts";
import { costUsdForHandle } from "./team.ts";

export function buildDispatchTool(daemon: DaemonContext, parentSessionId: string): ToolSpec {
  const {
    adapterFor,
    agentInboxes,
    agentStates,
    broadcast,
    capabilitiesForAgent,
    catalogModel,
    config,
    createTraceRecorder,
    dispatchLog,
    eventBus,
    gateForAgent,
    getKeychain,
    getOrCreateScope,
    http,
    isReadOnlyAgent,
    options,
    providers,
    redactor,
    resolveAgentModel,
    sessionScopes,
    teamCost,
    teamRegistry,
    teamTotal,
    todoSessionsDir,
    todoStore,
    warnPersistence,
  } = daemon;
  return createDispatchTool({
    dispatch: async (input, ctx) => {
      if (teamRegistry.list().length === 0) {
        return {
          content: "no agents enabled: enable at least one agent (leader is required)",
          isError: true,
        };
      }

      // Hard budget caps: throw before spawning any peer.
      const budgets = (config as unknown as { budgets?: TeamBudgets }).budgets;
      try {
        checkTeamBudgets({
          budgets,
          perAgentSpend: new Map(input.agents.map((a) => [a.handle, costUsdForHandle(daemon, a.handle)])),
          teamTotal: teamTotal.value,
          handles: input.agents.map((a) => a.handle),
        });
      } catch (error) {
        return { content: error instanceof Error ? error.message : String(error), isError: true };
      }
      const forecastThreshold = config.sandbox?.forecastCostUsd;
      if (forecastThreshold !== undefined) {
        const forecastAgents: DispatchAgentForecast[] = input.agents.map((a) => {
          const agent = teamRegistry.get(a.handle);
          const modelId = agent?.model ?? resolveAgentModel(agent?.provider ?? "", "");
          const modelInfo = agent ? catalogModel(agent.provider, modelId) : undefined;
          return {
            model: modelId || "unknown",
            inputPerMTok: modelInfo?.pricing.inputPerMTok ?? 0,
            outputPerMTok: modelInfo?.pricing.outputPerMTok ?? 0,
            effort: a.effort ?? agent?.effort,
          };
        });
        const estimate = estimateDispatchCost({
          briefChars: input.agents.reduce((sum, a) => sum + a.brief.length, 0),
          agents: forecastAgents,
        });
        try {
          await checkCostForecast({
            estimate,
            thresholdUsd: forecastThreshold,
            ask: ctx.requestApproval,
          });
        } catch (error) {
          return { content: error instanceof Error ? error.message : String(error), isError: true };
        }
      }

      // Parallel specialist spawn (item 52): every specialist is
      // spawned concurrently via a run_in_background-like spawn and
      // joined on a single promise barrier. Results keep input order
      // via index slots; each child gets only a lean brief slice and
      // the parent keeps only one-line summaries (lean context).
      const barrierNotify = (settled: Array<{ index: number; ok: boolean }>): void => {
        try {
          eventBus.emit("dispatch.complete", {
            count: settled.length,
            ok: settled.filter((s) => s.ok).length,
          });
        } catch {}
        try {
          broadcast(`team.shared`, { type: "dispatch_complete", count: settled.length });
        } catch {}
      };
      const dispatchBarrier = new PromiseBarrier<string>(input.agents.length, barrierNotify);
      const batchScheduler = new Scheduler({ maxConcurrent: Math.max(8, input.agents.length) });
      try {
        broadcast(`team.shared`, {
          type: "dispatch_start",
          count: input.agents.length,
          handles: input.agents.map((a) => a.handle),
        });
      } catch {}
      const dispatchTasks = input.agents.map((a, slot) =>
        (async () => {
          const agent = teamRegistry.get(a.handle);
          if (!agent) {
            dispatchBarrier.complete(
              slot,
              formatSkipLine({
                index: slot,
                handle: a.handle,
                reason: "unknown-handle",
                detail: `unknown handle: ${a.handle}`,
              }),
            );
            dispatchLog.append({
              index: slot,
              handle: a.handle,
              brief: a.brief,
              status: "skipped",
              reason: "unknown-handle",
            });
            return;
          }
          // Budget caps are checked before spawning: nothing starts once
          // the team total or this agent's session spend hits its cap.
          const dispatchBudgets = (
            config as unknown as { budgets?: { perAgentUsd?: number; teamUsd?: number } }
          ).budgets;
          if (dispatchBudgets?.teamUsd !== undefined && teamTotal.value >= dispatchBudgets.teamUsd) {
            dispatchBarrier.complete(
              slot,
              formatSkipLine({
                index: slot,
                handle: a.handle,
                reason: "team-budget-exceeded",
                detail: `team budget exceeded: ${teamTotal.value} >= ${dispatchBudgets.teamUsd}`,
              }),
            );
            dispatchLog.append({
              index: slot,
              handle: a.handle,
              brief: a.brief,
              status: "skipped",
              reason: "team-budget-exceeded",
            });
            return;
          }
          const spentForAgent = teamCost.get(agent.sessionId) ?? 0;
          if (dispatchBudgets?.perAgentUsd !== undefined && spentForAgent >= dispatchBudgets.perAgentUsd) {
            dispatchBarrier.complete(
              slot,
              formatSkipLine({
                index: slot,
                handle: a.handle,
                reason: "per-agent-budget-exceeded",
                detail: `budget exceeded: per-agent ${spentForAgent} >= ${dispatchBudgets.perAgentUsd}`,
              }),
            );
            dispatchLog.append({
              index: slot,
              handle: a.handle,
              brief: a.brief,
              status: "skipped",
              reason: "per-agent-budget-exceeded",
            });
            return;
          }
          const requestedEffort = resolveDispatchTarget(
            { handle: a.handle, brief: a.brief, effort: a.effort },
            undefined,
            {},
          ).effort;
          const effort =
            requestedEffort ?? (agent.effort === "auto" ? classifyEffortFromText(a.brief) : agent.effort);
          const childSessionId = agent.sessionId;
          try {
            todoStore.create(childSessionId);
          } catch {
            /* best-effort: session may already exist */
          }
          try {
            eventBus.emit("subagent.start", {
              sessionId: childSessionId,
              handle: a.handle,
              parentSessionId,
            });
            eventBus.emit("event", {
              event: "subagent.start",
              payload: { sessionId: childSessionId, handle: a.handle, parentSessionId },
            });
          } catch {}
          await getOrCreateScope(childSessionId, a.handle);
          const caps = agent.capabilities;
          const writeCapable = caps ? caps.some((c) => ["write", "edit", "bash"].includes(c)) : true;
          if (writeCapable) {
            const wtPath = join(options.workspaceRoot, ".agency", "worktrees", a.handle);
            try {
              await createWorktree(options.workspaceRoot, wtPath);
              const sc = sessionScopes.get(childSessionId);
              if (isReadOnlyAgent(a.handle)) {
                const scratchDir = join(".agency", "scratch", a.handle);
                const scratchAbs = makeWorktreeReadOnly(wtPath, scratchDir);
                if (sc) sc.bashState.cwd = scratchAbs;
              } else {
                if (sc) sc.bashState.cwd = wtPath;
              }
            } catch {
              const sc = sessionScopes.get(childSessionId);
              if (sc) sc.bashState.cwd = options.workspaceRoot;
            }
          }
          const tip = todoStore.latestTip(todoStore.load(childSessionId)) ?? null;
          await todoStore
            .append(childSessionId, {
              type: "agent_lifecycle",
              parentId: tip,
              handle: a.handle,
              state: "working",
              detail: a.brief,
            })
            .catch((error: unknown) => {
              warnPersistence("agent_lifecycle append", error);
            });
          agentStates.set(a.handle, "working");
          try {
            eventBus.emit("agent.lifecycle", { handle: a.handle, state: "working" });
          } catch {}
          if (teamRegistry.list().length > 1) {
            try {
              broadcast(`team.${childSessionId}`, {
                type: "agent_lifecycle",
                handle: a.handle,
                state: "working",
                detail: a.brief.slice(0, 200),
                sessionId: childSessionId,
              });
            } catch {}
            try {
              broadcast(`team.shared`, {
                type: "agent_lifecycle",
                handle: a.handle,
                state: "working",
                detail: a.brief.slice(0, 200),
                sessionId: childSessionId,
              });
            } catch {}
          }

          // --- Real turn execution (following task tool pattern at line 628) ---
          const childProvider = agent.provider;
          const childModel = agent.model ?? "";

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

          const childModelInfo = catalogModel(childProvider, childModel);
          const childTurnId = newEntryId();
          const startMs = Date.now();

          const freshSession: Message[] = [
            { role: "user", content: [{ type: "text", text: leanBrief(a.brief) }] },
          ];

          const childScope = sessionScopes.get(childSessionId);
          const childTools = childScope?.tools ?? [];
          const agentGate = gateForAgent(a.handle);
          const offeredTools = childTools
            .filter((t) => agentGate.toolOffered(t.name, t.riskTier))
            // Depth-0 child isolation: subagents cannot dispatch or spawn.
            .filter((t) => t.name !== "dispatch" && t.name !== "spawn");
          const agentCaps = capabilitiesForAgent(agentGate, childTools);

          const agentSystemPrompt = composeSystemPrompt({
            base: `You are ${a.handle}, a ${agent.role} agent. Complete the given brief concisely.`,
            familyPresetOverlay: undefined,
            instructions: [],
            toolDescriptions: [],
            context: buildEnvironmentBlock(gatherEnvironmentInfo({ cwd: options.workspaceRoot })),
          });

          const childTurn = await runChildTurn(
            { http, eventBus, createTraceRecorder },
            {
              adapter: adapterFor(childProvider),
              scheduler: batchScheduler,
              session: freshSession,
              systemPrompt: agentSystemPrompt.text,
              systemSegments: agentSystemPrompt.segments,
              tools: offeredTools,
              model: childModel,
              apiKey: childApiKey,
              provider: childProvider,
              identity: { type: "agent", name: a.handle },
              capabilities: agentCaps,
              toolPolicy: agentGate,
              pricePerMTok: childModelInfo
                ? {
                    input: childModelInfo.pricing.inputPerMTok,
                    output: childModelInfo.pricing.outputPerMTok,
                  }
                : undefined,
              maxTokensPerRequest: childModelInfo?.maxOutputTokens,
              turnId: childTurnId,
              sessionId: childSessionId,
              cwd: options.workspaceRoot,
              taskDepth: ctx.taskDepth + 1,
              doomLoopDetection: true,
              signal: ctx.signal,
              drainMailbox: () => {
                const msgs: import("@agency/schema").Message[] = [];
                const box = agentInboxes.get(a.handle);
                if (box && box.length > 0) {
                  msgs.push(...box);
                  box.length = 0;
                }
                const reg = teamRegistry.get(a.handle)?.mailbox;
                if (reg && reg.length > 0) {
                  msgs.push(...reg);
                  reg.length = 0;
                }
                return msgs;
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

          // Persist result as task_result entry
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
              tool: "dispatch",
              childSessionId,
              childTurnId,
              durationMs,
              summary: collapsed || leanSummary(finalText),
              prompt: leanPrompt(a.brief),
            });
          } catch (error: unknown) {
            warnPersistence("task_result append", error);
          }

          if (childError) {
            agentStates.set(a.handle, "failed");
            try {
              const tip2 = todoStore.latestTip(todoStore.load(childSessionId)) ?? null;
              await todoStore
                .append(childSessionId, {
                  type: "agent_lifecycle",
                  parentId: tip2,
                  handle: a.handle,
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
                  handle: a.handle,
                  state: "failed",
                });
              } catch {}
              try {
                broadcast(`team.shared`, {
                  type: "agent_lifecycle",
                  handle: a.handle,
                  state: "failed",
                });
              } catch {}
            }
            dispatchBarrier.complete(
              slot,
              `${a.handle}: ${childError instanceof Error ? childError.message : String(childError)}`,
            );
            dispatchLog.append({
              index: slot,
              handle: a.handle,
              brief: a.brief,
              status: "dispatched",
            });
          } else {
            agentStates.set(a.handle, "idle");
            try {
              const tip2 = todoStore.latestTip(todoStore.load(childSessionId)) ?? null;
              await todoStore
                .append(childSessionId, {
                  type: "agent_lifecycle",
                  parentId: tip2,
                  handle: a.handle,
                  state: "idle",
                  detail: "dispatch done",
                })
                .catch((error: unknown) => {
                  warnPersistence("agent_lifecycle append", error);
                });
            } catch (error: unknown) {
              warnPersistence("agent_lifecycle load", error);
            }
            if (childResult && childModelInfo) {
              const costUsd =
                (childResult.usage.inputTokens / 1_000_000) * childModelInfo.pricing.inputPerMTok +
                (childResult.usage.outputTokens / 1_000_000) * childModelInfo.pricing.outputPerMTok;
              teamCost.set(childSessionId, (teamCost.get(childSessionId) ?? 0) + costUsd);
              teamTotal.value += costUsd;
            }
            if (teamRegistry.list().length > 1) {
              try {
                broadcast(`team.${childSessionId}`, {
                  type: "agent_lifecycle",
                  handle: a.handle,
                  state: "idle",
                });
              } catch {}
              try {
                broadcast(`team.shared`, {
                  type: "agent_lifecycle",
                  handle: a.handle,
                  state: "idle",
                });
              } catch {}
            }
            dispatchBarrier.complete(
              slot,
              `${a.handle} dispatched at ${effort}: ${leanSummary(finalText, 80) || "(no output)"}`,
            );
            dispatchLog.append({
              index: slot,
              handle: a.handle,
              brief: a.brief,
              effort,
              status: "dispatched",
            });
          }
        })().catch((error: unknown) => {
          dispatchBarrier.fail(slot, error);
        }),
      );
      await Promise.all(dispatchTasks);
      const dispatchSettled = await dispatchBarrier.wait();
      try {
        await dispatchLog.save(join(todoSessionsDir, "dispatch-state.json"));
      } catch (error: unknown) {
        warnPersistence("dispatch-state save", error);
      }
      const lines = dispatchSettled.map((s) =>
        s.ok
          ? (s.value as string)
          : `${input.agents[s.index]?.handle ?? s.index}: ${s.error instanceof Error ? s.error.message : String(s.error)}`,
      );
      return { content: lines.join("\n") };
    },
  });
}
