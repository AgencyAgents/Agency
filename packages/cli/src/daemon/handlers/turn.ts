import {
  addUsage,
  CODE_TOOL,
  type ToolSpec as CoreToolSpec,
  codeRunner,
  codeRunnerReadPaths,
  codeTool,
  deferTools,
  isTeamLive,
  LEAD_WITHHELD_TOOLS,
  type LoopEvent,
  parseHandles,
  parseSlashInput,
  runCommandHooks,
  runSetupScript,
  runTurn,
  TraceRecorder,
  withTrace,
} from "@agency/core";
import {
  buildScriptSandboxArgv,
  type PermissionMode,
  type PermissionsGate,
  scriptSandboxAvailable,
  scriptSandboxEnv,
} from "@agency/guard";
import { clampEffortForModel, type KeychainBackend, keyEnvName, resolveApiKey } from "@agency/providers";
import type { MethodHandler } from "@agency/rpc";
import { AgencyError, ErrorCode } from "@agency/schema";
import type { TurnTiming } from "@agency/telemetry";
import { modelCommandEnv, resolveConfiguredShell, type SessionScope } from "@agency/tools";
import {
  assertPreflightCaps,
  estimatePreflightTurnCostUsd,
  modelRunOptions,
  recordTurnCompletion,
} from "../costing.ts";
import { sandboxWindowsShell } from "../session-scopes.ts";
import { assertTaskPreflightCaps } from "../task-ledger.ts";
import { costUsdForHandle, drainParentInbox, findChildSession, handleForSession } from "../team-context.ts";
import {
  autoReviewerFor,
  classifyEffortWithSmallModel,
  type DaemonContext,
  HEARTBEAT_INTERVAL_MS,
  keySourcesFor,
  PLAN_EXIT_TOOL,
  type RunTurnParams,
  type RunTurnRpcResult,
  resolvePrompt,
  resolveSystemPrompt,
  STRUCTURED_OUTPUT_TOOL,
  type TeamBudgets,
} from "../types.ts";
import { applyMcpPrompt, applySlashCommand } from "./commands.ts";
import { createTurnApproval } from "./plan.ts";
import { generateSessionTitle } from "./session.ts";
import { writeTurnCassette } from "./trace.ts";

export function registerTurnHandlers(handlers: Record<string, MethodHandler>, ctx: DaemonContext): void {
  handlers.run_turn = async (rawParams, context) => {
    return executeTurn(ctx, rawParams as RunTurnParams, { clientId: context.clientId });
  };
  handlers.cancel_turn = async (rawParams) => {
    const { turnId } = rawParams as { turnId: string };
    const controller = ctx.activeControllers.get(turnId);
    if (!controller) return { cancelled: false };
    controller.abort();
    // A turn parked at the ask gate awaits an approval promise the abort
    // signal alone never settles, so without this run_turn would hang past
    // cancellation. Refusing the pending asks lets the loop observe the
    // abort and finish instead of deadlocking.
    for (const manager of ctx.approvalManagers.values()) manager.rejectTurn(turnId);
    return { cancelled: true };
  };
  // The record of a turn holds its key: only these fields go out.
  handlers.turns_list = async () => ({
    turns: [...ctx.activeTurnMeta].map(([turnId, meta]) => ({
      turnId,
      sessionId: meta.sessionId,
      provider: meta.provider,
      model: meta.model,
      startedAt: meta.startedAt,
    })),
  });
}

/** The source of the error that a prompt hook's refusal throws: session_send removes the prompt on it. */
export const PROMPT_HOOK_SOURCE = "prompt-hook";

/** The type of a provider error in the names of Claude Code, for the StopFailure hook. */
const STOP_FAILURE_TYPES: Partial<Record<ErrorCode, string>> = {
  [ErrorCode.AUTH]: "authentication_failed",
  [ErrorCode.RATE_LIMIT]: "rate_limit",
  [ErrorCode.OVERLOAD]: "overloaded",
  [ErrorCode.TRANSIENT]: "server_error",
  [ErrorCode.NETWORK]: "unknown",
  [ErrorCode.PROXY]: "unknown",
};

/** The input of a UserPromptExpansion hook: a typed command that became the text of the prompt. */
type PromptExpansion = Record<
  "expansion_type" | "command_name" | "command_args" | "command_source" | "prompt",
  string
>;

function userTextOf(session: RunTurnParams["session"]): string {
  const block = session.at(-1)?.content?.find((c: { type: string }) => c.type === "text") as
    | { text?: string }
    | undefined;
  return typeof block?.text === "string" ? block.text : "";
}

/** Runs the prompt hooks of the config. Their text goes to the session inbox: the loop stores it with the turn. */
async function runPromptHooks(
  ctx: DaemonContext,
  sessionId: string,
  prompt: string,
  session: RunTurnParams["session"],
  expansion: PromptExpansion | undefined,
  setup: { signal: AbortSignal; once: boolean },
): Promise<void> {
  const opts = ctx.hookRun;
  const context: string[] = [];
  if (expansion) {
    const expanded = await runCommandHooks(
      ctx.commandHooks,
      "UserPromptExpansion",
      { session_id: sessionId, ...expansion },
      opts,
    );
    if (expanded.block !== undefined) {
      throw new AgencyError(ErrorCode.INVALID_REQUEST, `a hook blocked the command: ${expanded.block}`, {
        source: PROMPT_HOOK_SOURCE,
      });
    }
    if (expanded.context !== undefined) context.push(expanded.context);
  }
  // No reply in the history yet: this is the first prompt of the session.
  if (!session.some((m) => m.role === "assistant")) {
    // A turn with no session id has no session to remember the run in: it runs the script every time.
    if (ctx.config.setupScript && !(setup.once && ctx.setupDone.has(sessionId))) {
      const failure = await runSetupScript(ctx.config.setupScript, opts, setup.signal);
      if (failure !== undefined) {
        throw new AgencyError(ErrorCode.INVALID_REQUEST, `the setup script failed: ${failure}`, {
          source: PROMPT_HOOK_SOURCE,
        });
      }
      if (setup.once) ctx.setupDone.add(sessionId);
    }
    const start = await runCommandHooks(
      ctx.commandHooks,
      "SessionStart",
      { session_id: sessionId, source: "startup" },
      opts,
    );
    if (start.context !== undefined) context.push(start.context);
  }
  const submit = await runCommandHooks(
    ctx.commandHooks,
    "UserPromptSubmit",
    { session_id: sessionId, prompt },
    opts,
  );
  if (submit.block !== undefined) {
    throw new AgencyError(ErrorCode.INVALID_REQUEST, `a hook blocked the prompt: ${submit.block}`, {
      source: PROMPT_HOOK_SOURCE,
    });
  }
  if (submit.context !== undefined) context.push(submit.context);
  if (context.length === 0) return;
  const box = ctx.sessionInboxes.get(sessionId) ?? [];
  ctx.sessionInboxes.set(sessionId, box);
  box.push({
    role: "user",
    content: [{ type: "text", text: `<hook-context>\n${context.join("\n")}\n</hook-context>` }],
  });
}

let codeModeWarned = false;

/** Shared turn assembly behind run_turn and session_send: one definition,
 *  so daemon-owned and caller-owned turns never drift apart. */
export async function executeTurn(
  ctx: DaemonContext,
  params: RunTurnParams,
  rpc: { clientId: string },
  hooks?: {
    onContextOverflow?: (overheadTokens?: number) => Promise<import("@agency/schema").Message[] | undefined>;
    onMessage?: (
      message: import("@agency/schema").Message,
      origin?: import("@agency/core").MessageOrigin,
    ) => Promise<void>;
  },
): Promise<RunTurnRpcResult> {
  const {
    activeControllers,
    activeTurnMeta,
    adapterFor,
    approvalsFor,
    boardStore,
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
    sessionInboxes,
    shellLabel,
    teamContexts,
    teamFor,
    teamRegistry,
    telemetry,
    todoSessionsDir,
    todoStore,
    trustStore,
    tools,
    turnOwners,
    warnPersistence,
  } = ctx;
  {
    const controller = new AbortController();
    activeControllers.set(params.turnId, controller);
    turnOwners.set(params.turnId, rpc.clientId);
    const eventStream = `turn.${params.turnId}`;

    // R10 wiring: the whole turn (provider requests and tool calls) correlates under one trace ID.
    return withTrace(async () => {
      const startedAt = new Date().toISOString();
      if (configFingerprint.check()) {
        logger.warn("config or binary changed; this daemon leaves when it is idle");
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
              ...keySourcesFor(params.provider, providers),
            });
          })());
        if (apiKey === undefined) {
          throw new AgencyError(
            ErrorCode.AUTH,
            `no API key for provider "${params.provider}": set ${keyEnvName(params.provider)} or run \`agency auth login ${params.provider}\``,
            { source: "daemon" },
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
          const cfgAgents = (
            config as unknown as { agents?: Record<string, { effort: string; enabled?: boolean }> }
          ).agents;
          const leaderHandle =
            (config as unknown as { leader?: string }).leader ??
            Object.keys(cfgAgents ?? {}).find((h) => cfgAgents?.[h]?.enabled);
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
        const childInfo = findChildSession(ctx, params.sessionId ?? "default");
        const budgetParent = childInfo?.parentSessionId ?? params.sessionId ?? "default";
        if (perAgentBudget !== undefined) {
          const agentHandle = childInfo?.handle ?? handleForSession(ctx, params.sessionId ?? "default");
          const spent = agentHandle
            ? costUsdForHandle(ctx, agentHandle, childInfo?.parentSessionId)
            : (teamFor(budgetParent).teamCost.get(params.sessionId ?? "default") ?? 0);
          if (spent >= perAgentBudget)
            throw new Error(`budget exceeded: per-agent ${spent} >= ${perAgentBudget}`);
        }
        if (teamBudget !== undefined && teamFor(budgetParent).teamTotal.value >= teamBudget)
          throw new Error(`team budget exceeded: ${teamFor(budgetParent).teamTotal.value} >= ${teamBudget}`);

        await ctx.learnModel(resolvedProvider, resolvedModel, http);
        const modelInfo = catalogModel(resolvedProvider, resolvedModel);
        // Clamp the resolved thinking level to what the model actually supports
        if (resolvedThinkingLevel && modelInfo) {
          resolvedThinkingLevel = clampEffortForModel(
            resolvedThinkingLevel as import("@agency/providers").ThinkingLevel,
            modelInfo,
          );
        }
        // Hard daily and monthly caps stop before the first provider call:
        // the pre-flight estimate plus spend to date must fit under each cap.
        assertPreflightCaps(ctx, {
          sessionId,
          systemPrompt: params.systemPrompt,
          session: params.session,
          ...(modelInfo?.pricing === undefined ? {} : { pricing: modelInfo.pricing }),
        });
        // Per-task ledger caps stop before the first provider call too,
        // on the same estimate the sibling gate uses.
        assertTaskPreflightCaps({
          board: boardStore,
          ...(ctx.taskLedger === undefined ? {} : { ledger: ctx.taskLedger }),
          handle: childInfo?.handle ?? handleForSession(ctx, params.sessionId ?? "default"),
          estimateUsd: estimatePreflightTurnCostUsd({
            systemPrompt: params.systemPrompt,
            session: params.session,
            ...(modelInfo?.pricing === undefined ? {} : { pricing: modelInfo.pricing }),
          }),
          announce: { bus: ctx.eventBus, sessionId },
        });
        // Usage of the model requests that finished. A turn that then fails or moves to the fallback still spent it.
        let spent: import("@agency/providers").Usage = { inputTokens: 0, outputTokens: 0 };
        const turnTiming: { value?: TurnTiming } = {};
        const wrappedOnEvent = (event: LoopEvent): void => {
          if (event.type === "turn_complete") {
            spent = addUsage(spent, event.usage);
          }
          // A cancelled request reports no timing, so it adds none to the turn.
          if (event.type === "turn_complete" && event.timing) {
            turnTiming.value = {
              ttftMs: turnTiming.value?.ttftMs ?? event.timing.ttftMs,
              streamMs: (turnTiming.value?.streamMs ?? 0) + event.timing.streamMs,
              outputTokens: (turnTiming.value?.outputTokens ?? 0) + event.usage.outputTokens,
            };
          }
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
        const typed = userTextOf(params.session);
        applySlashCommand(commands, options.workspaceRoot, params.session, {
          command: resolveConfiguredShell(process.platform, sandboxWindowsShell(config)),
          env: { CLAUDE_CODE_SESSION_ID: sessionId },
        });
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
          turnScope = await getOrCreateScope(
            sessionId,
            mentioned.length === 1 ? mentioned[0] : undefined,
            params.mcp,
          );
          await turnScope.todos.hydrate(sessionId);
          await applyMcpPrompt(turnScope.mcp, params.session);
        }
        const slash = parseSlashInput(typed);
        const template = slash && commands.find((c) => c.name === slash.name);
        const expansion: PromptExpansion | undefined =
          slash && userTextOf(params.session) !== typed
            ? {
                expansion_type: template ? "slash_command" : "mcp_prompt",
                command_name: slash.name,
                command_args: slash.args,
                command_source: template ? template.source : "mcp",
                prompt: typed,
              }
            : undefined;
        const requestApproval = createTurnApproval(ctx, params, sessionId, eventStream);
        const reviewApproval = autoReviewerFor(ctx, params.permissionMode);
        const fallbackRef = (() => {
          const fm =
            params.fallbackModel ?? (config as unknown as { fallback_model?: string }).fallback_model;
          if (!fm) return undefined;
          const slash = fm.indexOf("/");
          if (slash <= 0) return undefined;
          return { provider: fm.slice(0, slash), model: fm.slice(slash + 1) };
        })();

        // A fallback continues from these: a restart would run the primary's tools a second time.
        const carried: import("@agency/schema").Message[] = [];
        const onPrimaryMessage = async (
          message: import("@agency/schema").Message,
          origin?: import("@agency/core").MessageOrigin,
        ): Promise<void> => {
          carried.push(message);
          await hooks?.onMessage?.(message, origin);
        };
        let result: Awaited<ReturnType<typeof runTurn>>;
        // The model that produced the result: a fallback has its own name and price in the cost records.
        let served = { provider: resolvedProvider, model: resolvedModel, info: modelInfo };
        const turnTeam = teamFor(childInfo?.parentSessionId ?? sessionId);
        const recordSpend = (ran: Pick<typeof served, "model" | "info">, usage: typeof spent): number =>
          recordTurnCompletion(ctx, {
            team: turnTeam,
            sessionId,
            handle: childInfo?.handle ?? handleForSession(ctx, params.sessionId ?? "default") ?? "lead",
            model: ran.model,
            usage,
            ...(ran.info?.pricing === undefined ? {} : { pricing: ran.info.pricing }),
            turnId: params.turnId,
            eventStreams: [eventStream],
            ...(childInfo?.parentSessionId === undefined
              ? {}
              : { parentSessionId: childInfo.parentSessionId }),
            board: boardStore,
          });
        const recordFailedSpend = (ran: Pick<typeof served, "model" | "info">): void => {
          if (spent.inputTokens + spent.outputTokens > 0) recordSpend(ran, spent);
          spent = { inputTokens: 0, outputTokens: 0 };
        };
        const deferMode = config.mcpDeferTools ?? "auto";
        // The loop validates the input of a tool against its schema, so a wrong answer goes back to the model.
        const structuredTools: CoreToolSpec[] =
          params.outputSchema === undefined
            ? []
            : [
                {
                  name: STRUCTURED_OUTPUT_TOOL,
                  description:
                    "Gives the final answer of the task in the required structure. Call it one time, when the work is done.",
                  inputSchema: params.outputSchema,
                  riskTier: "safe",
                  handler: async () => ({ content: "The answer is recorded. End the turn now." }),
                },
              ];
        // An approved plan moves the rest of the turn, and the agents it starts, to allow-edits.
        let turnMode: PermissionMode = params.permissionMode ?? "ask";
        const planExitTools = (gate: PermissionsGate): CoreToolSpec[] =>
          turnMode !== "plan" || params.nonInteractive === true
            ? []
            : [
                {
                  name: PLAN_EXIT_TOOL,
                  description:
                    "Plan mode only. Shows the user your finished plan and asks for approval. On approval, plan mode ends and you can edit files and run commands. Call it once, after you explored with read-only tools.",
                  inputSchema: {
                    type: "object",
                    properties: { plan: { type: "string", description: "The full plan, as markdown." } },
                    required: ["plan"],
                  },
                  riskTier: "safe",
                  handler: async (input) => {
                    if (turnMode !== "plan") {
                      return { content: "The plan is already approved: carry it out.", isError: true };
                    }
                    const plan = typeof input.plan === "string" ? input.plan.trim() : "";
                    if (plan === "")
                      return { content: "plan_exit needs the plan as markdown.", isError: true };
                    const answer = await requestApproval({
                      tool: PLAN_EXIT_TOOL,
                      title: plan,
                      riskTier: "moderate",
                      oneTime: true,
                    });
                    // Two plans in one batch: the first approval already ended plan mode.
                    if (turnMode !== "plan") {
                      return { content: "The plan is already approved: carry it out.", isError: true };
                    }
                    if (answer === "reject") {
                      return {
                        content:
                          "The plan was not approved: the user rejected it or did not answer in time. Plan mode stays on. Ask what to change or revise the plan, then call plan_exit again.",
                      };
                    }
                    turnMode = "allow-edits";
                    gate.setMode(turnMode);
                    const meta = activeTurnMeta.get(params.turnId);
                    if (meta) meta.permissionMode = turnMode;
                    const changed = { type: "mode_changed" as const, mode: turnMode };
                    broadcast(eventStream, changed);
                    if (params.sessionId !== undefined) broadcast(`session.${sessionId}`, changed);
                    return {
                      content:
                        "The user approved the plan. Plan mode is over for this turn: you can write and edit files now. Carry out the plan.",
                    };
                  },
                },
              ];
        // `true` needs the script sandbox. `"host"` runs the script with the authority of a shell command, so it is
        // only for the software backend: a sandbox for commands must not have a tool that goes around it.
        const isolatedRunner =
          config.codeMode === true && (await scriptSandboxAvailable(codeRunnerReadPaths()))
            ? buildScriptSandboxArgv(codeRunner(), codeRunnerReadPaths())
            : undefined;
        if (config.codeMode === true && !isolatedRunner && !codeModeWarned) {
          codeModeWarned = true;
          logger.warn(
            "codeMode is true, but this machine has no sandbox for scripts: the code tool is not offered",
          );
        }
        const hostCode = config.codeMode === "host" && (config.sandbox?.backend ?? "software") === "software";
        const codeTools = (gate: {
          toolOffered(tool: string, riskTier?: "dangerous"): boolean;
        }): CoreToolSpec[] => {
          if (!gate.toolOffered(CODE_TOOL, "dangerous")) return [];
          if (isolatedRunner) return [codeTool(() => scriptSandboxEnv(), isolatedRunner)];
          return hostCode ? [codeTool(() => modelCommandEnv())] : [];
        };
        // A built-in tool that `--tools` leaves out is denied, so it is not offered; this wins over an allow rule.
        const turnPermissions =
          params.tools === undefined
            ? params.permissions
            : {
                ...params.permissions,
                ...Object.fromEntries(
                  [...(builtinsMode && turnScope ? turnScope.tools : tools), { name: CODE_TOOL }]
                    .filter((t) => !("origin" in t && t.origin === "mcp") && !params.tools?.includes(t.name))
                    .map((t) => [t.name, "deny" as const]),
                ),
              };
        try {
          const effectiveCapabilities =
            params.capabilities ??
            (builtinsMode ? await defaultCapabilitiesForSession(sessionId) : defaultCapabilitiesSync);
          const effectiveMcpFailures = builtinsMode ? turnScope?.mcpFailures : undefined;
          const sessionGate = gateForSession(sessionId).withMode(turnMode).withRules(turnPermissions);
          const gatedTools =
            builtinsMode && turnScope
              ? turnScope.tools.filter((t) => sessionGate.toolOffered(t.name, t.riskTier))
              : tools.filter((t) => sessionGate.toolOffered(t.name, t.riskTier));
          const leadTurn = !findChildSession(ctx, sessionId) && !handleForSession(ctx, sessionId);
          const withheld = new Set<string>(LEAD_WITHHELD_TOOLS);
          const offeredTools =
            leadTurn && isTeamLive(boardStore.list())
              ? gatedTools.filter((t) => !withheld.has(t.name))
              : gatedTools;
          const effectiveTools = [
            ...deferTools(offeredTools, deferMode),
            ...codeTools(sessionGate),
            ...structuredTools,
            ...planExitTools(sessionGate),
          ];
          activeTurnMeta.set(params.turnId, {
            capabilities: effectiveCapabilities,
            tools: effectiveTools,
            sessionId,
            provider: params.provider,
            model: params.model,
            apiKey,
            startedAt,
            budget: params.budget,
            taskDepth: (params as unknown as { taskDepth?: number }).taskDepth ?? 0,
            permissionMode: turnMode,
          });
          ctx.steerableSessions.add(sessionId);
          try {
            // Root turns drain the session inbox (fed by session_message);
            // agent turns additionally drain their own mailbox, same call.
            const mailboxDrain = (): import("@agency/schema").Message[] => {
              const msgs: import("@agency/schema").Message[] = [];
              const queued = sessionInboxes.get(sessionId);
              if (queued && queued.length > 0) {
                msgs.push(...queued);
                queued.length = 0;
              }
              const child = findChildSession(ctx, sessionId);
              if (child) {
                const team = teamContexts.get(child.parentSessionId);
                const box = team?.agentInboxes.get(child.childKey);
                if (box && box.length > 0) {
                  msgs.push(...box);
                  box.length = 0;
                }
              } else {
                const agentForSession = teamRegistry.list().find((a) => a.sessionId === sessionId);
                const handle = agentForSession?.handle ?? (mentioned.length === 1 ? mentioned[0] : undefined);
                if (handle === undefined) return msgs;
                const team = teamContexts.get(sessionId);
                if (team) msgs.push(...drainParentInbox(team, handle));
                const reg = teamRegistry.get(handle)?.mailbox;
                if (reg && reg.length > 0) {
                  msgs.push(...reg);
                  reg.length = 0;
                }
              }
              return msgs;
            };
            const promptText = (() => {
              const m = params.session[params.session.length - 1];
              const b = m?.content?.find((c: { type: string }) => c.type === "text") as
                | { text?: string }
                | undefined;
              return typeof b?.text === "string" ? b.text : "";
            })();
            try {
              eventBus.emit("prompt.submit", { sessionId, prompt: promptText });
              eventBus.emit("event", {
                event: "prompt.submit",
                payload: { sessionId, prompt: promptText },
              });
            } catch {}
            if (!childInfo) {
              await runPromptHooks(ctx, sessionId, promptText, params.session, expansion, {
                signal: controller.signal,
                once: params.sessionId !== undefined,
              });
            }
            const mainPrompt = resolvePrompt(params, {
              workspaceRoot: options.workspaceRoot,
              mcpFailures: effectiveMcpFailures,
              shellLabel,
              trustStore,
              pluginInstructions: ctx.pluginInstructions,
              memoryFile: ctx.memoryFile,
              userAgentInstructions: ctx.userAgentInstructions,
              environments: ctx.sessionEnvironments,
            });
            result = await runTurn(adapterFor(resolvedProvider), schedulerFor(resolvedProvider), http, {
              identity,
              capabilities: effectiveCapabilities,
              toolPolicy: sessionGate,
              requestApproval,
              ...(reviewApproval ? { reviewApproval } : {}),
              eventBus,
              redactToolResult: redactor.redactToolResult,
              drainMailbox: mailboxDrain,
              // An empty drain here is the turn's last look at the inbox: later messages start a turn instead.
              drainSteering: () => {
                const late = sessionInboxes.get(sessionId)?.splice(0) ?? [];
                if (late.length === 0) ctx.steerableSessions.delete(sessionId);
                return late;
              },
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
              ...modelRunOptions(modelInfo),
              turnId: params.turnId,
              sessionId: params.sessionId,
              cwd: options.workspaceRoot,
              maxToolIterations: params.maxToolIterations ?? config.maxSteps,
              ...(config.compactionInstructions
                ? { compactionInstructions: config.compactionInstructions }
                : {}),
              ...(config.compactionLimit ? { compactionLimit: config.compactionLimit } : {}),
              ...(config.keepToolResults ? { keepToolResults: true } : {}),
              ...(template && template.allowedTools ? { grantedTools: template.allowedTools } : {}),
              signal: controller.signal,
              taskDepth: (params as unknown as { taskDepth?: number }).taskDepth ?? 0,
              onEvent: wrappedOnEvent,
              ...(hooks?.onContextOverflow ? { onContextOverflow: hooks.onContextOverflow } : {}),
              onMessage: onPrimaryMessage,
            });
          } finally {
            activeTurnMeta.delete(params.turnId);
            ctx.steerableSessions.delete(sessionId);
          }
        } catch (error) {
          recordFailedSpend(served);
          const isRetryable =
            error instanceof AgencyError &&
            (error.code === ErrorCode.OVERLOAD ||
              error.code === ErrorCode.TRANSIENT ||
              error.code === ErrorCode.RATE_LIMIT);
          if (
            isRetryable &&
            fallbackRef &&
            (fallbackRef.provider !== params.provider || fallbackRef.model !== params.model)
          ) {
            let fbApiKey: string | undefined;
            try {
              fbApiKey = await resolveApiKey({
                provider: fallbackRef.provider,
                env: process.env,
                keychain: await getKeychain().catch(() => undefined),
                config: providers[fallbackRef.provider]?.apiKey,
                ...keySourcesFor(fallbackRef.provider, providers),
              });
            } catch {}
            // No key for the fallback provider: the primary key must not go to another vendor.
            if (!fbApiKey) throw error;
            redactor.registerSecret(fbApiKey);
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
            const sessionGate = gateForSession(sessionId).withMode(turnMode).withRules(turnPermissions);
            const fallbackCapabilities =
              params.capabilities ??
              (builtinsMode ? await defaultCapabilitiesForSession(sessionId) : defaultCapabilitiesSync);
            const fallbackMcpFailures = builtinsMode ? turnScope?.mcpFailures : undefined;
            const fallbackTools = [
              ...deferTools(
                builtinsMode && turnScope
                  ? turnScope.tools.filter((t) => sessionGate.toolOffered(t.name, t.riskTier))
                  : tools.filter((t) => sessionGate.toolOffered(t.name, t.riskTier)),
                deferMode,
              ),
              ...codeTools(sessionGate),
              ...structuredTools,
              ...planExitTools(sessionGate),
            ];
            activeTurnMeta.set(params.turnId, {
              capabilities: fallbackCapabilities,
              tools: fallbackTools,
              sessionId,
              provider: fallbackRef.provider,
              model: fallbackRef.model,
              apiKey: fbApiKey,
              startedAt,
              budget: params.budget,
              taskDepth: (params as unknown as { taskDepth?: number }).taskDepth ?? 0,
              permissionMode: turnMode,
            });
            // The fallback model's own limits: the primary's output limit can be too large for it.
            const fallbackInfo = catalogModel(fallbackRef.provider, fallbackRef.model);
            const fallbackPrompt = resolvePrompt(
              { ...params, permissionMode: turnMode },
              {
                workspaceRoot: options.workspaceRoot,
                mcpFailures: fallbackMcpFailures,
                shellLabel,
                trustStore,
                pluginInstructions: ctx.pluginInstructions,
                memoryFile: ctx.memoryFile,
                userAgentInstructions: ctx.userAgentInstructions,
                environments: ctx.sessionEnvironments,
              },
            );
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
                  ...(reviewApproval ? { reviewApproval } : {}),
                  eventBus,
                  redactToolResult: redactor.redactToolResult,
                  systemPrompt: fallbackPrompt.text,
                  systemSegments: fallbackPrompt.segments,
                  tools: fallbackTools,
                  model: fallbackRef.model,
                  apiKey: fbApiKey,
                  thinkingLevel: params.thinkingLevel,
                  session: [...params.session, ...carried],
                  budget: params.budget,
                  ...modelRunOptions(fallbackInfo),
                  turnId: params.turnId,
                  sessionId: params.sessionId,
                  cwd: options.workspaceRoot,
                  maxToolIterations: params.maxToolIterations ?? config.maxSteps,
                  ...(config.compactionInstructions
                    ? { compactionInstructions: config.compactionInstructions }
                    : {}),
                  ...(config.compactionLimit ? { compactionLimit: config.compactionLimit } : {}),
                  ...(config.keepToolResults ? { keepToolResults: true } : {}),
                  ...(template && template.allowedTools ? { grantedTools: template.allowedTools } : {}),
                  signal: controller.signal,
                  taskDepth: (params as unknown as { taskDepth?: number }).taskDepth ?? 0,
                  provider: fallbackRef.provider,
                  promptVersion: tracePromptVersion,
                  traceRecorder,
                  onEvent: wrappedOnEvent,
                  ...(hooks?.onContextOverflow ? { onContextOverflow: hooks.onContextOverflow } : {}),
                  ...(hooks?.onMessage ? { onMessage: hooks.onMessage } : {}),
                },
              );
              served = { provider: fallbackRef.provider, model: fallbackRef.model, info: fallbackInfo };
            } catch (fallbackError) {
              recordFailedSpend({ model: fallbackRef.model, info: fallbackInfo });
              throw fallbackError;
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
              trustStore,
              pluginInstructions: ctx.pluginInstructions,
              memoryFile: ctx.memoryFile,
              userAgentInstructions: ctx.userAgentInstructions,
              environments: ctx.sessionEnvironments,
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

        const turnCost = recordSpend(served, result.usage);
        if (budgets?.teamUsd !== undefined && turnTeam.teamTotal.value >= budgets.teamUsd) {
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
          cacheWriteInputTokens: result.usage.cacheWriteInputTokens ?? null,
          costUsd: turnCost,
        });
        telemetry.record("turn_complete", {
          provider: served.provider,
          stopReason: result.stopReason,
          inputTokens: result.usage.inputTokens,
          outputTokens: result.usage.outputTokens,
          cachedInputTokens: result.usage.cachedInputTokens ?? null,
          cacheWriteInputTokens: result.usage.cacheWriteInputTokens ?? null,
          costUsd: turnCost,
        });

        // Generate session title after first turn if none exists yet
        void generateSessionTitle(ctx, params, sessionId);

        const response: RunTurnRpcResult = {
          ...result,
          ...(turnTiming.value === undefined ? {} : { timing: turnTiming.value }),
          cancelled: controller.signal.aborted,
          permissionMode: turnMode,
          ...(served.provider === resolvedProvider
            ? {}
            : { servedBy: { provider: served.provider, model: served.model } }),
        };
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
            error: { code: error.code, message: error.message },
            needsCompaction: true,
          };
          return response;
        }
        logger.error("turn failed", {
          turnId: params.turnId,
          error: error instanceof Error ? error.message : String(error),
        });
        const failure = error instanceof AgencyError ? STOP_FAILURE_TYPES[error.code] : undefined;
        if (failure !== undefined && !((params as { taskDepth?: number }).taskDepth ?? 0)) {
          // No decision control: the error goes back at once, and the hook runs on.
          void runCommandHooks(
            ctx.commandHooks,
            "StopFailure",
            {
              session_id: params.sessionId ?? "default",
              error: failure,
              error_details: (error as AgencyError).message,
              last_assistant_message: `API Error: ${(error as AgencyError).message}`,
            },
            ctx.hookRun,
          ).catch(() => {});
        }
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
  }
}
