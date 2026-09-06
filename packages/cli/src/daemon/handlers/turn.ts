import { type LoopEvent, parseHandles, runTurn, TraceRecorder, withTrace } from "@agency/core";
import { clampEffortForModel, type KeychainBackend, resolveApiKey } from "@agency/providers";
import type { MethodHandler } from "@agency/rpc";
import { AgencyError, ErrorCode } from "@agency/schema";
import type { SessionScope } from "@agency/tools";
import {
  classifyEffortWithSmallModel,
  type DaemonContext,
  HEARTBEAT_INTERVAL_MS,
  oauthOverridesFor,
  type RunTurnParams,
  type RunTurnRpcResult,
  resolvePrompt,
  resolveSystemPrompt,
  type TeamBudgets,
} from "../types.ts";
import { applySlashCommand } from "./commands.ts";
import { createTurnApproval } from "./plan.ts";
import { generateSessionTitle } from "./session.ts";
import { costUsdForHandle } from "./team.ts";
import { writeTurnCassette } from "./trace.ts";

export function registerTurnHandlers(handlers: Record<string, MethodHandler>, ctx: DaemonContext): void {
  const {
    activeControllers,
    activeTurnMeta,
    adapterFor,
    agentInboxes,
    approvalManagers,
    approvalsFor,
    broadcast,
    builtinsMode,
    catalogModel,
    commands,
    config,
    configFingerprint,
    defaultCapabilitiesForSession,
    defaultCapabilitiesSync,
    eventBus,
    gateForSession,
    getKeychain,
    getOrCreateScope,
    http,
    identity,
    logger,
    options,
    providers,
    redactor,
    schedulerFor,
    shellLabel,
    teamCost,
    teamRegistry,
    teamTotal,
    telemetry,
    todoSessionsDir,
    todoStore,
    tools,
    turnOwners,
    warnPersistence,
  } = ctx;
  handlers.run_turn = async (rawParams, context) => {
    const params = rawParams as RunTurnParams;
    const controller = new AbortController();
    activeControllers.set(params.turnId, controller);
    turnOwners.set(params.turnId, context.clientId);
    const eventStream = `turn.${params.turnId}`;

    // R10 wiring: the whole turn (provider requests and tool calls) correlates under one trace ID.
    return withTrace(async () => {
      if (configFingerprint.check()) {
        logger.warn("config changed, restart daemon to apply");
      }
      // Turn heartbeats keep heartbeat-aware clients' deadlines alive
      // through silent stretches (a long tool call emits no deltas).
      const turnHeartbeat = setInterval(() => {
        broadcast(eventStream, { type: "heartbeat" });
      }, HEARTBEAT_INTERVAL_MS);
      try {
        const apiKey =
          params.apiKey ??
          (await (async () => {
            let keychain: KeychainBackend | undefined;
            try {
              keychain = await getKeychain();
            } catch {
              // No usable keychain: env/config resolution still applies.
            }
            return resolveApiKey({
              provider: params.provider,
              env: process.env,
              keychain,
              config: providers[params.provider]?.apiKey,
              ...oauthOverridesFor(params.provider, providers),
            });
          })());
        if (apiKey === undefined) {
          throw new Error(
            `no API key for provider "${params.provider}": set AGENCY_${params.provider.toUpperCase()}_API_KEY or run \`agency auth login ${params.provider}\``,
          );
        }
        redactor.registerSecret(apiKey);
        logger.info("turn started", {
          turnId: params.turnId,
          provider: params.provider,
          model: params.model,
        });
        const sessionId = params.sessionId ?? "default";
        const tracePromptVersion =
          params.promptVersion ??
          (params.systemPromptParts?.identity || params.systemPromptParts?.role
            ? `${params.systemPromptParts?.identity ?? ""}|${params.systemPromptParts?.role ?? ""}`.slice(
                0,
                200,
              )
            : undefined);
        let traceRecorder: TraceRecorder | undefined;
        const collectedTraceEvents: LoopEvent[] = [];
        try {
          traceRecorder = new TraceRecorder({
            sessionsDir: todoSessionsDir,
            sessionId,
            traceId: params.turnId,
            promptVersion: tracePromptVersion,
            provider: params.provider,
            model: params.model,
            redactor,
          });
        } catch (error: unknown) {
          warnPersistence("TraceRecorder create", error);
        }
        let resolvedProvider = params.provider;
        let resolvedModel = params.model;
        let resolvedThinkingLevel = params.thinkingLevel as string | undefined;
        const lastUserText = (() => {
          const m = params.session[params.session.length - 1];
          const b = m?.content?.find((c: { type: string }) => c.type === "text") as
            | { text?: string }
            | undefined;
          return typeof b?.text === "string" ? b.text : "";
        })();
        const mentioned = parseHandles(lastUserText).filter((h) => teamRegistry.has(h));
        if (mentioned.length === 1) {
          const handle = mentioned.at(0);
          const agent = handle !== undefined ? teamRegistry.get(handle) : undefined;
          if (agent) {
            resolvedProvider = agent.provider;
            resolvedModel = agent.model ?? "";
            if (agent.effort === "auto" && !resolvedThinkingLevel) {
              // Directly-addressed agent with auto effort (no dispatcher):
              // traced small-model classification, keyword heuristic fallback.
              resolvedThinkingLevel = await classifyEffortWithSmallModel(lastUserText, {
                config: config as Record<string, unknown>,
                adapterFor,
                http,
                apiKey,
                providers: providers as Record<
                  string,
                  { apiKey?: string; family?: string; baseUrl?: string }
                >,
                traceRecorder,
              });
            }
          }
        } else if (mentioned.length === 0 && params.thinkingLevel === undefined) {
          const cfgAgents = (config as unknown as { agents?: Record<string, { effort: string }> }).agents;
          const leaderHandle =
            (config as unknown as { leader?: string }).leader ??
            (cfgAgents ? Object.keys(cfgAgents)[0] : undefined);
          const leaderEffort = leaderHandle ? cfgAgents?.[leaderHandle]?.effort : undefined;
          if (leaderEffort === "auto") {
            // Leader case (no dispatcher): use small-model classification
            // instead of keyword heuristic
            resolvedThinkingLevel = await classifyEffortWithSmallModel(lastUserText, {
              config: config as Record<string, unknown>,
              adapterFor,
              http,
              apiKey,
              providers: providers as Record<string, { apiKey?: string; family?: string; baseUrl?: string }>,
              traceRecorder,
            });
          }
        }
        const budgets = (config as unknown as { budgets?: TeamBudgets }).budgets;
        const perAgentBudget = budgets?.perAgentUsd;
        const teamBudget = budgets?.teamUsd;
        if (perAgentBudget !== undefined) {
          const agentForSession = teamRegistry
            .list()
            .find((a) => a.sessionId === (params.sessionId ?? "default"));
          const spent = agentForSession
            ? costUsdForHandle(ctx, agentForSession.handle)
            : (teamCost.get(params.sessionId ?? "default") ?? 0);
          if (spent >= perAgentBudget)
            throw new Error(`budget exceeded: per-agent ${spent} >= ${perAgentBudget}`);
        }
        if (teamBudget !== undefined && teamTotal.value >= teamBudget)
          throw new Error(`team budget exceeded: ${teamTotal.value} >= ${teamBudget}`);

        const modelInfo = catalogModel(resolvedProvider, resolvedModel);
        // Clamp the resolved thinking level to what the model actually supports
        if (resolvedThinkingLevel && modelInfo) {
          resolvedThinkingLevel = clampEffortForModel(
            resolvedThinkingLevel as import("@agency/providers").EffortLevel,
            modelInfo,
          );
        }
        const wrappedOnEvent = (event: LoopEvent): void => {
          collectedTraceEvents.push(event);
          broadcast(eventStream, event);
        };
        const isNewSession = todoStore.load(sessionId).length === 0 && params.session.length > 0;
        if (isNewSession) {
          try {
            eventBus.emit("session.created", { sessionId });
            eventBus.emit("session.start", { sessionId, workspaceRoot: options.workspaceRoot });
            eventBus.emit("event", { event: "session.created", payload: { sessionId } });
            eventBus.emit("event", {
              event: "session.start",
              payload: { sessionId, workspaceRoot: options.workspaceRoot },
            });
          } catch {}
        }
        applySlashCommand(commands, options.workspaceRoot, params.session);
        if (params.images?.length) {
          const last = params.session[params.session.length - 1];
          if (last && last.role === "user") {
            last.content = [...last.content, ...params.images];
          } else {
            params.session = [...params.session, { role: "user", content: [...params.images] }];
          }
        }
        let turnScope: SessionScope | undefined;
        if (builtinsMode) {
          turnScope = await getOrCreateScope(sessionId, mentioned.length === 1 ? mentioned[0] : undefined);
          await turnScope.todos.hydrate(sessionId);
        }
        const requestApproval = createTurnApproval(ctx, params, sessionId, eventStream);
        const fallbackRef = (() => {
          const fm = (config as unknown as { fallback_model?: string }).fallback_model;
          if (!fm) return undefined;
          const slash = fm.indexOf("/");
          if (slash <= 0) return undefined;
          return { provider: fm.slice(0, slash), model: fm.slice(slash + 1) };
        })();

        let result: Awaited<ReturnType<typeof runTurn>>;
        try {
          const effectiveCapabilities =
            params.capabilities ??
            (builtinsMode ? await defaultCapabilitiesForSession(sessionId) : defaultCapabilitiesSync);
          const effectiveMcpFailures = builtinsMode ? turnScope?.mcpFailures : undefined;
          const sessionGate = gateForSession(sessionId);
          const effectiveTools =
            builtinsMode && turnScope
              ? turnScope.tools.filter((t) => sessionGate.toolOffered(t.name, t.riskTier))
              : tools.filter((t) => sessionGate.toolOffered(t.name, t.riskTier));
          activeTurnMeta.set(params.turnId, {
            capabilities: effectiveCapabilities,
            tools: effectiveTools,
            sessionId,
            provider: params.provider,
            model: params.model,
            apiKey,
            budget: params.budget,
            taskDepth: (params as unknown as { taskDepth?: number }).taskDepth ?? 0,
          });
          try {
            const mailboxDrain = (() => {
              const agentForSession = teamRegistry.list().find((a) => a.sessionId === sessionId);
              const handle = agentForSession?.handle ?? (mentioned.length === 1 ? mentioned[0] : undefined);
              if (!handle) return undefined;
              return () => {
                const msgs: import("@agency/schema").Message[] = [];
                const box = agentInboxes.get(handle);
                if (box && box.length > 0) {
                  msgs.push(...box);
                  box.length = 0;
                }
                const reg = teamRegistry.get(handle)?.mailbox;
                if (reg && reg.length > 0) {
                  msgs.push(...reg);
                  reg.length = 0;
                }
                return msgs;
              };
            })();
            try {
              const promptText = (() => {
                const m = params.session[params.session.length - 1];
                const b = m?.content?.find((c: { type: string }) => c.type === "text") as
                  | { text?: string }
                  | undefined;
                return typeof b?.text === "string" ? b.text : "";
              })();
              eventBus.emit("prompt.submit", { sessionId, prompt: promptText });
              eventBus.emit("event", {
                event: "prompt.submit",
                payload: { sessionId, prompt: promptText },
              });
            } catch {}
            const mainPrompt = resolvePrompt(params, {
              workspaceRoot: options.workspaceRoot,
              mcpFailures: effectiveMcpFailures,
              shellLabel,
            });
            result = await runTurn(adapterFor(resolvedProvider), schedulerFor(resolvedProvider), http, {
              identity,
              capabilities: effectiveCapabilities,
              toolPolicy: sessionGate,
              requestApproval,
              eventBus,
              drainMailbox: mailboxDrain,
              systemPrompt: mainPrompt.text,
              systemSegments: mainPrompt.segments,
              tools: effectiveTools,
              model: resolvedModel,
              apiKey,
              provider: resolvedProvider,
              promptVersion: tracePromptVersion,
              traceRecorder,
              thinkingLevel:
                (resolvedThinkingLevel as import("@agency/providers").ThinkingLevel | undefined) ??
                params.thinkingLevel,
              session: params.session,
              budget: params.budget,
              pricePerMTok: modelInfo
                ? {
                    input: modelInfo.pricing.inputPerMTok,
                    output: modelInfo.pricing.outputPerMTok,
                  }
                : undefined,
              maxTokensPerRequest: modelInfo?.maxOutputTokens,
              turnId: params.turnId,
              sessionId: params.sessionId,
              cwd: options.workspaceRoot,
              maxToolIterations: params.maxToolIterations,
              signal: controller.signal,
              taskDepth: (params as unknown as { taskDepth?: number }).taskDepth ?? 0,
              onEvent: wrappedOnEvent,
            });
          } finally {
            activeTurnMeta.delete(params.turnId);
          }
        } catch (error) {
          const isRetryable =
            error instanceof AgencyError &&
            (error.code === ErrorCode.OVERLOAD ||
              error.code === ErrorCode.TRANSIENT ||
              error.code === ErrorCode.RATE_LIMIT);
          if (isRetryable && fallbackRef && fallbackRef.provider !== params.provider) {
            const fbEvent = {
              type: "fallback" as const,
              from: `${params.provider}/${params.model}`,
              to: `${fallbackRef.provider}/${fallbackRef.model}`,
              reason: error instanceof Error ? error.message : String(error),
            };
            broadcast(eventStream, fbEvent);
            try {
              eventBus.emit("model.fallback", fbEvent);
            } catch {}
            const fbApiKey = await (async () => {
              let kc: KeychainBackend | undefined;
              try {
                kc = await getKeychain();
              } catch {}
              const k = await resolveApiKey({
                provider: fallbackRef.provider,
                env: process.env,
                keychain: kc,
                config: providers[fallbackRef.provider]?.apiKey,
                ...oauthOverridesFor(fallbackRef.provider, providers),
              });
              return k ?? apiKey;
            })();
            if (fbApiKey) redactor.registerSecret(fbApiKey);
            const sessionGate = gateForSession(sessionId);
            const fallbackCapabilities =
              params.capabilities ??
              (builtinsMode ? await defaultCapabilitiesForSession(sessionId) : defaultCapabilitiesSync);
            const fallbackMcpFailures = builtinsMode ? turnScope?.mcpFailures : undefined;
            const fallbackTools =
              builtinsMode && turnScope
                ? turnScope.tools.filter((t) => sessionGate.toolOffered(t.name, t.riskTier))
                : tools.filter((t) => sessionGate.toolOffered(t.name, t.riskTier));
            activeTurnMeta.set(params.turnId, {
              capabilities: fallbackCapabilities,
              tools: fallbackTools,
              sessionId,
              provider: fallbackRef.provider,
              model: fallbackRef.model,
              apiKey: fbApiKey ?? apiKey,
              budget: params.budget,
              taskDepth: (params as unknown as { taskDepth?: number }).taskDepth ?? 0,
            });
            const fallbackPrompt = resolvePrompt(params, {
              workspaceRoot: options.workspaceRoot,
              mcpFailures: fallbackMcpFailures,
              shellLabel,
            });
            try {
              result = await runTurn(
                adapterFor(fallbackRef.provider),
                schedulerFor(fallbackRef.provider),
                http,
                {
                  identity,
                  capabilities: fallbackCapabilities,
                  toolPolicy: sessionGate,
                  requestApproval,
                  eventBus,
                  systemPrompt: fallbackPrompt.text,
                  systemSegments: fallbackPrompt.segments,
                  tools: fallbackTools,
                  model: fallbackRef.model,
                  apiKey: fbApiKey ?? apiKey,
                  thinkingLevel: params.thinkingLevel,
                  session: params.session,
                  budget: params.budget,
                  pricePerMTok: modelInfo
                    ? {
                        input: modelInfo.pricing.inputPerMTok,
                        output: modelInfo.pricing.outputPerMTok,
                      }
                    : undefined,
                  maxTokensPerRequest: modelInfo?.maxOutputTokens,
                  turnId: params.turnId,
                  sessionId: params.sessionId,
                  cwd: options.workspaceRoot,
                  maxToolIterations: params.maxToolIterations,
                  signal: controller.signal,
                  taskDepth: (params as unknown as { taskDepth?: number }).taskDepth ?? 0,
                  provider: fallbackRef.provider,
                  promptVersion: tracePromptVersion,
                  traceRecorder,
                  onEvent: wrappedOnEvent,
                },
              );
            } finally {
              activeTurnMeta.delete(params.turnId);
            }
          } else {
            throw error;
          }
        }
        try {
          if (traceRecorder) {
            const cassetteMcpFailures = builtinsMode ? turnScope?.mcpFailures : undefined;
            const sysPrompt = resolveSystemPrompt(params, {
              workspaceRoot: options.workspaceRoot,
              mcpFailures: cassetteMcpFailures,
              shellLabel,
            });
            writeTurnCassette(traceRecorder, params, sysPrompt, collectedTraceEvents, result);
          }
        } catch (error: unknown) {
          warnPersistence("cassette write", error);
        }
        try {
          eventBus.emit("session.idle", { sessionId });
          eventBus.emit("event", { event: "session.idle", payload: { sessionId } });
        } catch {}

        const costUsd = modelInfo
          ? (result.usage.inputTokens / 1_000_000) * modelInfo.pricing.inputPerMTok +
            (result.usage.outputTokens / 1_000_000) * modelInfo.pricing.outputPerMTok
          : 0;
        const sidKey = sessionId;
        teamCost.set(sidKey, (teamCost.get(sidKey) ?? 0) + costUsd);
        teamTotal.value += costUsd;
        if (budgets?.teamUsd !== undefined && teamTotal.value >= budgets.teamUsd) {
          for (const c of activeControllers.values())
            try {
              c.abort();
            } catch {}
        }
        logger.info("turn finished", {
          turnId: params.turnId,
          stopReason: result.stopReason,
          inputTokens: result.usage.inputTokens,
          outputTokens: result.usage.outputTokens,
          cachedInputTokens: result.usage.cachedInputTokens ?? null,
        });
        telemetry.record("turn_complete", {
          provider: resolvedProvider,
          stopReason: result.stopReason,
          inputTokens: result.usage.inputTokens,
          outputTokens: result.usage.outputTokens,
          cachedInputTokens: result.usage.cachedInputTokens ?? null,
        });

        // Generate session title after first turn if none exists yet
        void generateSessionTitle(ctx, params, sessionId);

        const response: RunTurnRpcResult = { ...result, cancelled: controller.signal.aborted };
        return response;
      } catch (error) {
        if (error instanceof AgencyError && error.code === ErrorCode.CONTEXT_OVERFLOW) {
          // The loop throws before pushing any assistant message, so the
          // input session is the full message list. Report the overflow as
          // a result instead of an RPC error: the caller owns the
          // SessionStore and is the one who can compact and retry.
          logger.warn("context overflow: client should compact and retry", {
            turnId: params.turnId,
            provider: params.provider,
            model: params.model,
          });
          const response: RunTurnRpcResult = {
            messages: params.session,
            stopReason: "error",
            usage: { inputTokens: 0, outputTokens: 0 },
            budgetExceeded: false,
            cancelled: controller.signal.aborted,
            needsCompaction: true,
          };
          return response;
        }
        logger.error("turn failed", {
          turnId: params.turnId,
          error: error instanceof Error ? error.message : String(error),
        });
        telemetry.recordCrash("run_turn", error);
        throw error;
      } finally {
        clearInterval(turnHeartbeat);
        // A turn that died (abort, disconnect, error) must not leave asks
        // pending forever: reject anything it was waiting on.
        approvalsFor(params.sessionId ?? "default").rejectTurn(params.turnId);
        activeControllers.delete(params.turnId);
        turnOwners.delete(params.turnId);
      }
    });
  };
  handlers.cancel_turn = async (rawParams) => {
    const { turnId } = rawParams as { turnId: string };
    const controller = activeControllers.get(turnId);
    if (!controller) return { cancelled: false };
    controller.abort();
    // A turn parked at the ask gate awaits an approval promise the abort
    // signal alone never settles, so without this run_turn would hang past
    // cancellation. Refusing the pending asks lets the loop observe the
    // abort and finish instead of deadlocking.
    for (const manager of approvalManagers.values()) manager.rejectTurn(turnId);
    return { cancelled: true };
  };
}
