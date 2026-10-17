import { randomUUID } from "node:crypto";
import {
  addUsage,
  buildEnvironmentBlock,
  CALL_TOOL,
  CODE_TOOL,
  compact,
  composeSystemPrompt,
  gatherEnvironmentInfo,
  generateTitle,
  getSessionTitle,
  type MessageOrigin,
  modelSummarizer,
  newEntryId,
  projectSessionView,
  resolveSmallModel,
  runChildTurn,
  type SentRequest,
  type Summarizer,
  summarizeAtEnd,
  summarizeTranscript,
  TOOL_SEARCH,
  type ToolSpec,
  withOverhead,
} from "@agency/core";
import { type Capabilities, type PermissionsGate, sandboxNetwork } from "@agency/guard";
import {
  type KeychainBackend,
  pickCheapModel,
  resolveApiKey,
  tokenizerFor,
  type Usage,
} from "@agency/providers";
import type { MethodHandler } from "@agency/rpc";
import type { Message } from "@agency/schema";
import { AgencyError, ErrorCode } from "@agency/schema";
import { appendUsageEntry } from "@agency/telemetry";
import {
  createSpawnTool,
  extractFinalText,
  type SessionScope,
  type ToolSpec as ToolsToolSpec,
} from "@agency/tools";
import { modelRunOptions } from "../costing.ts";
import { handleForSession, NO_AGENTS_MESSAGE } from "../team-context.ts";
import {
  autoReviewerFor,
  type DaemonContext,
  DEFAULT_SYSTEM_PROMPT,
  keySourcesFor,
  PLAN_EXIT_TOOL,
  projectInstructions,
  type RunTurnParams,
  type SessionMessageParams,
  type SessionSendParams,
  type SessionSendResult,
  STRUCTURED_OUTPUT_TOOL,
} from "../types.ts";
import { setSessionGoal } from "./goal.ts";
import { executeTurn, PROMPT_HOOK_SOURCE } from "./turn.ts";

/** Fallback window for daemon-side proactive compaction, matching the
 *  former client default until the catalog supplies a real one. */
const DEFAULT_SESSION_CONTEXT_WINDOW = 200_000;

/** The last request of each recent session, with the entry it ends on: a compaction asks its summary there. */
const sentRequests = new Map<string, { sent: SentRequest; tip: string | null }>();
const SENT_SESSIONS = 16;

/** The summarizer of a session's compaction: its own model writes the summary. With no key, the offline one. */
export function sessionSummarizer(
  ctx: DaemonContext,
  provider: string,
  model: string,
  /** Instructions for this one summary (`/compact <session> <text>`): they go after those of the config. */
  extraInstructions?: string,
  onUsage?: (usage: Usage) => void,
): Summarizer {
  let inner: Summarizer | undefined;
  const wanted = [ctx.config.compactionInstructions, extraInstructions].filter(Boolean).join("\n");
  const summarize: Summarizer = async (transcript, instructions) => {
    if (inner === undefined) {
      const apiKey = await resolveApiKey({
        provider,
        env: process.env,
        keychain: await ctx.getKeychain().catch(() => undefined),
        config: ctx.providers[provider]?.apiKey,
        ...keySourcesFor(provider, ctx.providers),
      }).catch(() => undefined);
      const maxTokens = ctx.catalogModel(provider, model)?.maxOutputTokens;
      inner = apiKey
        ? modelSummarizer({
            adapter: ctx.adapterFor(provider),
            http: ctx.http,
            model,
            apiKey,
            ...(maxTokens ? { maxTokens } : {}),
            ...(wanted ? { instructions: wanted } : {}),
            ...(onUsage ? { onUsage } : {}),
          })
        : async (text) => summarizeTranscript(text);
    }
    return inner(transcript, instructions);
  };
  summarize.detailed = true;
  return summarize;
}

export async function generateSessionTitle(
  ctx: DaemonContext,
  params: RunTurnParams,
  sessionId: string,
): Promise<void> {
  const { adapterFor, config, getKeychain, http, listModels, providers, todoStore } = ctx;
  if (!getSessionTitle(todoStore.load(sessionId))) {
    const firstUserMsg = params.session.find((m: Message) => m.role === "user");
    const firstUserText = firstUserMsg?.content?.find((b: { type: string }) => b.type === "text") as
      | { text?: string }
      | undefined;
    if (firstUserText?.text) {
      const titlePrompt = firstUserText.text;
      const smallModelRef = resolveSmallModel(config);
      if (smallModelRef) {
        (async () => {
          try {
            let kc: KeychainBackend | undefined;
            try {
              kc = await getKeychain();
            } catch {}
            const smallApiKey = await resolveApiKey({
              provider: smallModelRef.provider,
              env: process.env,
              keychain: kc,
              config: providers[smallModelRef.provider]?.apiKey,
              ...keySourcesFor(smallModelRef.provider, providers),
            });
            if (smallApiKey) {
              // Background-turn cheap routing: titles run on the cheapest
              // same-family model, never silently, via the taskKind tag.
              let cheapModel: string | undefined;
              try {
                const sameFamily = listModels().filter((m) => m.family === smallModelRef.provider);
                const cheap = pickCheapModel(sameFamily);
                if (cheap && cheap.id !== smallModelRef.model) cheapModel = cheap.id;
              } catch {
                // Catalog failure keeps the configured small model.
              }
              const title = await generateTitle(titlePrompt, {
                config,
                http,
                apiKey: smallApiKey,
                providerConfig: providers,
                adapterFor: (p: string) => adapterFor(p),
                ...(cheapModel ? { cheapModel } : {}),
              });
              // The user can name the session while the title model runs; their name wins.
              if (title && !getSessionTitle(todoStore.load(sessionId))) {
                const tip = todoStore.latestTip(todoStore.load(sessionId)) ?? null;
                await todoStore.append(sessionId, { type: "session_title", parentId: tip, title });
              }
            }
          } catch {
            // Title generation failure must not fail the turn
          }
        })();
      }
    }
  }
}

export function registerSessionHandlers(handlers: Record<string, MethodHandler>, ctx: DaemonContext): void {
  const {
    approvalManagers,
    broadcast,
    providers,
    sessionBudgets,
    sessionInboxes,
    sessionScopes,
    todoStore,
    turnCheckpoints,
  } = ctx;
  handlers.session_delete = async (rawParams) => {
    const { sessionId } = rawParams as { sessionId: string };
    if (!sessionId)
      throw new AgencyError(ErrorCode.INVALID_REQUEST, "session_delete requires sessionId", {
        source: "session",
      });
    // The turn would write on into a removed file, and its scope would be gone under it.
    if (sendQueues.has(sessionId))
      throw new AgencyError(
        ErrorCode.INVALID_REQUEST,
        "the session runs a turn: stop it, then delete the session",
        {
          source: "session",
        },
      );
    const scope = sessionScopes.get(sessionId);
    if (scope) {
      try {
        await scope.dispose();
      } catch {}
      sessionScopes.delete(sessionId);
    }
    approvalManagers.delete(sessionId);
    // A session has one end here: its removal. Only a session that exists has an end.
    if (todoStore.list().includes(sessionId)) {
      try {
        ctx.eventBus.emit("session.end", { sessionId, reason: "other" });
      } catch {}
    }
    try {
      todoStore.delete(sessionId);
    } catch {}
    return { deleted: true };
  };
  handlers.session_fork = async (rawParams) => {
    const { sessionId, fromTipId, label } = rawParams as {
      sessionId: string;
      fromTipId?: string;
      label?: string;
    };
    if (!sessionId)
      throw new AgencyError(ErrorCode.INVALID_REQUEST, "session_fork requires sessionId", {
        source: "session",
      });
    if (todoStore.load(sessionId).length === 0)
      throw new AgencyError(ErrorCode.INVALID_REQUEST, `unknown session: ${sessionId}`, {
        source: "session",
      });
    const entry = await todoStore.fork(sessionId, {
      ...(fromTipId === undefined ? {} : { fromTipId }),
      ...(label === undefined ? {} : { label }),
    });
    return { forked: true, sessionId, tipId: entry.id };
  };
  handlers.session_clone = async (rawParams) => {
    const { sessionId, newSessionId } = rawParams as {
      sessionId: string;
      newSessionId?: string;
    };
    if (!sessionId)
      throw new AgencyError(ErrorCode.INVALID_REQUEST, "session_clone requires sessionId", {
        source: "session",
      });
    if (todoStore.load(sessionId).length === 0)
      throw new AgencyError(ErrorCode.INVALID_REQUEST, `unknown session: ${sessionId}`, {
        source: "session",
      });
    const meta = todoStore.clone(
      sessionId,
      typeof newSessionId === "string" && newSessionId.length > 0 ? newSessionId : undefined,
    );
    return { cloned: true, sessionId: meta.id };
  };
  handlers.session_show = async (rawParams) => {
    const { sessionId, tipId } = rawParams as { sessionId: string; tipId?: string };
    if (!sessionId)
      throw new AgencyError(ErrorCode.INVALID_REQUEST, "session_show requires sessionId", {
        source: "session",
      });
    const view = projectSessionView(todoStore, sessionId, tipId);
    if (!view)
      throw new AgencyError(ErrorCode.INVALID_REQUEST, `unknown session: ${sessionId}`, {
        source: "session",
      });
    const budget = ctx.sessionBudgets.get(sessionId);
    return { ...view, ...(budget === undefined ? {} : { budget }) };
  };
  // One turn at a time for each session: two sends that start from the same tip fork the history, and one turn is lost.
  const sendQueues = new Map<string, Promise<unknown>>();
  handlers.session_send = async (rawParams, context) => {
    const p = rawParams as SessionSendParams;
    if (!p.sessionId)
      throw new AgencyError(ErrorCode.INVALID_REQUEST, "session_send requires sessionId", {
        source: "session",
      });
    if (!p.userText)
      throw new AgencyError(ErrorCode.INVALID_REQUEST, "session_send requires userText", {
        source: "session",
      });
    // Owned while it waits: a disconnect removes the owner, and a turn with no owner does not start.
    const turnId = p.turnId ?? randomUUID();
    ctx.turnOwners.set(turnId, context.clientId);
    const turn = (sendQueues.get(p.sessionId) ?? Promise.resolve()).then(() => {
      if (!ctx.turnOwners.has(turnId))
        throw new AgencyError(ErrorCode.INTERNAL, "the client left before its turn started", {
          source: "session",
        });
      return sendTurn({ ...p, turnId }, context);
    });
    const settled = turn.catch(() => {});
    sendQueues.set(p.sessionId, settled);
    void settled.then(() => {
      ctx.turnOwners.delete(turnId);
      if (sendQueues.get(p.sessionId) === settled) sendQueues.delete(p.sessionId);
    });
    return turn;
  };
  const sendTurn = async (
    p: SessionSendParams,
    context: { clientId: string },
  ): Promise<SessionSendResult> => {
    const store = todoStore;
    if (!store.list().includes(p.sessionId)) {
      store.create(p.sessionId);
      // The turn handler sees a session that holds its first prompt already, and does not take it for a new one.
      const start = { sessionId: p.sessionId, workspaceRoot: ctx.options.workspaceRoot };
      try {
        ctx.eventBus.emit("session.start", start);
        ctx.eventBus.emit("event", { event: "session.start", payload: start });
      } catch {}
    }
    const family = providers[p.provider]?.family ?? p.provider;
    const tokenizer = tokenizerFor(family);
    // The model's own window, not a fixed guess: a small-window model overflows long before 200k tokens.
    const window = p.contextWindow ?? ctx.catalogModel(p.provider, p.model)?.contextWindow;
    const threshold = {
      contextWindow: window || DEFAULT_SESSION_CONTEXT_WINDOW,
      ...(ctx.config.compactionLimit ? { limitTokens: ctx.config.compactionLimit } : {}),
    };
    const turnId = p.turnId ?? randomUUID();
    // The summaries of this turn's compactions are paid with the turn.
    let compactionUsage: Usage = { inputTokens: 0, outputTokens: 0 };
    const payCompaction = (usage: Usage): void => {
      compactionUsage = addUsage(compactionUsage, usage);
    };
    const summarizeAll = sessionSummarizer(ctx, p.provider, p.model, undefined, payCompaction);
    // The summary takes a model call: the client shows that the session compacts meanwhile.
    const summarize: typeof summarizeAll = async (...args) => {
      broadcast(`turn.${turnId}`, { type: "compaction", phase: "start", sessionId: p.sessionId });
      try {
        return await summarizeAll(...args);
      } finally {
        broadcast(`turn.${turnId}`, { type: "compaction", phase: "end", sessionId: p.sessionId });
      }
    };
    summarize.detailed = summarizeAll.detailed;
    // The summary of the chain up to `from`, at the end of the last request: only while that request is in the chain.
    const wholeAt = (from: string) => async (): Promise<string | undefined> => {
      const known = sentRequests.get(p.sessionId);
      const entries = store.load(p.sessionId);
      if (known?.tip == null || !store.chainFor(entries, from).some((e) => e.id === known.tip))
        return undefined;
      const prefix = store.messagesFor(entries, known.tip).length;
      if (prefix !== known.sent.request.messages.length) return undefined;
      broadcast(`turn.${turnId}`, { type: "compaction", phase: "start", sessionId: p.sessionId });
      try {
        return await summarizeAtEnd(
          ctx.adapterFor(p.provider),
          ctx.http,
          known.sent,
          store.messagesFor(entries, from).slice(prefix),
          ctx.config.compactionInstructions,
          payCompaction,
        );
      } finally {
        broadcast(`turn.${turnId}`, { type: "compaction", phase: "end", sessionId: p.sessionId });
      }
    };
    if (p.goal !== undefined) await setSessionGoal(ctx, p.sessionId, p.goal);
    let tipId = store.latestTip(store.load(p.sessionId)) ?? null;
    let compacted = false;
    // undo_run restores this tip, so the whole turn (user text included) rolls back.
    const checkpoints = turnCheckpoints.get(p.sessionId) ?? [];
    checkpoints.push(tipId);
    turnCheckpoints.set(p.sessionId, checkpoints);
    if (tipId) {
      summarize.whole = wholeAt(tipId);
      const outcome = await compact(store, p.sessionId, tipId, tokenizer, threshold, summarize);
      tipId = outcome.tipId;
      compacted = outcome.compacted;
    }
    const userEntry = await store.append(p.sessionId, {
      type: "message",
      parentId: tipId,
      message: { role: "user", content: [{ type: "text", text: p.userText }, ...(p.images ?? [])] },
      turnId,
    });
    let history = store.messagesFor(store.load(p.sessionId), userEntry.id);
    // Reactive compaction forks the branch, so new appends rebase onto
    // the compacted tip instead of the orphaned pre-compaction entry.
    let tip: string | null = userEntry.id;
    const onContextOverflow = async (overheadTokens = 0): Promise<Message[]> => {
      // From the current tip, not the prompt: the steps this turn has done stay in the model's view.
      const from = tip ?? userEntry.id;
      const room = withOverhead(threshold, overheadTokens);
      summarize.whole = wholeAt(from);
      const outcome = await compact(store, p.sessionId, from, tokenizer, room, summarize, 4, {
        force: true,
      });
      history = store.messagesFor(store.load(p.sessionId), outcome.tipId);
      tip = outcome.tipId;
      compacted = true;
      return history;
    };
    const runParams: RunTurnParams = {
      turnId,
      sessionId: p.sessionId,
      provider: p.provider,
      model: p.model,
      systemPrompt: p.systemPrompt ?? DEFAULT_SYSTEM_PROMPT,
      systemPromptParts: p.systemPromptParts,
      thinkingLevel: p.thinkingLevel,
      session: history,
      budget: p.budget ?? sessionBudgets.get(p.sessionId),
      permissionMode: p.permissionMode,
      ...(p.permissions === undefined ? {} : { permissions: p.permissions }),
      ...(p.mcp === undefined ? {} : { mcp: p.mcp }),
      ...(p.fallbackModel === undefined ? {} : { fallbackModel: p.fallbackModel }),
      ...(p.tools === undefined ? {} : { tools: p.tools }),
      maxToolIterations: p.maxToolIterations,
      nonInteractive: p.nonInteractive,
      ...(p.images?.length ? { images: p.images } : {}),
    };
    // Each message is stored as the turn produces it: a failed turn or a dead daemon keeps the finished steps.
    const onMessage = async (message: Message, origin?: MessageOrigin): Promise<void> => {
      tip = (
        await store.append(p.sessionId, {
          type: "message",
          parentId: tip,
          message,
          ...(origin ? { origin } : {}),
        })
      ).id;
    };
    const onSent = (sent: SentRequest): void => {
      sentRequests.delete(p.sessionId);
      sentRequests.set(p.sessionId, { sent, tip });
      for (const id of sentRequests.keys()) if (sentRequests.size > SENT_SESSIONS) sentRequests.delete(id);
    };
    const hooks = { onContextOverflow, onMessage, onSent };
    let result: Awaited<ReturnType<typeof executeTurn>>;
    try {
      result = await executeTurn(ctx, runParams, { clientId: context.clientId }, hooks);
    } catch (error) {
      // A prompt that a hook refused is not part of the session: the model must not see it in the next turn.
      if (error instanceof AgencyError && error.source === PROMPT_HOOK_SOURCE) {
        await store.rollback(p.sessionId, checkpoints.pop() ?? null);
      }
      throw error;
    }
    if (result.needsCompaction) {
      history = await onContextOverflow();
      runParams.session = history;
      result = await executeTurn(ctx, runParams, { clientId: context.clientId }, hooks);
    }
    const served = result.servedBy ?? p;
    if (compactionUsage.inputTokens > 0)
      result = { ...result, usage: addUsage(result.usage, compactionUsage) };
    const parentId = await appendUsageEntry(store, p.sessionId, tip, {
      usage: result.usage,
      model: served.model,
      pricing: ctx.catalogModel(served.provider, served.model)?.pricing,
      ...(result.timing === undefined ? {} : { timing: result.timing }),
      ...(result.contextTokens === undefined ? {} : { contextTokens: result.contextTokens }),
    });
    const response: SessionSendResult = {
      ...result,
      sessionId: p.sessionId,
      turnId,
      tipId: parentId,
      compacted,
    };
    return response;
  };
  handlers.session_message = async (rawParams) => {
    const { sessionId, text } = rawParams as SessionMessageParams;
    if (!sessionId)
      throw new AgencyError(ErrorCode.INVALID_REQUEST, "session_message requires sessionId", {
        source: "session",
      });
    if (!text)
      throw new AgencyError(ErrorCode.INVALID_REQUEST, "session_message requires text", {
        source: "session",
      });
    // No turn will read it: queued, it would only surface inside some later turn. The client sends a turn instead.
    if (!ctx.steerableSessions.has(sessionId)) return { queued: false, depth: 0 };
    const box = sessionInboxes.get(sessionId) ?? [];
    sessionInboxes.set(sessionId, box);
    box.push({ role: "user", content: [{ type: "text", text }] });
    broadcast(`session.${sessionId}`, { type: "session_message", sessionId });
    return { queued: true, depth: box.length };
  };
}

export function sessionToolsFor(list: ToolSpec[], offerGate: PermissionsGate): readonly string[] | "*" {
  const offered = list.filter((t) => offerGate.toolOffered(t.name, t.riskTier));
  if (offered.length === list.length) return "*" as const;
  // The tools that a turn adds are not in `list`. A turn adds one only when the gate offers it.
  return [
    ...offered.map((t) => t.name),
    TOOL_SEARCH,
    CALL_TOOL,
    CODE_TOOL,
    STRUCTURED_OUTPUT_TOOL,
    PLAN_EXIT_TOOL,
  ];
}

export function gateForSession(ctx: DaemonContext, sessionId: string): PermissionsGate {
  const { gate, gateForAgent } = ctx;
  const ownerHandle = handleForSession(ctx, sessionId);
  return ownerHandle ? gateForAgent(ownerHandle) : gate;
}

export async function defaultCapabilitiesForSession(
  ctx: DaemonContext,
  sessionId?: string,
): Promise<Capabilities> {
  const { builtinsMode, gate, getOrCreateScope, options, sessionScopes, tools } = ctx;
  if (options.capabilities) return options.capabilities;
  if (!builtinsMode) {
    return {
      tools: sessionToolsFor(tools, gate),
      pathScopes: "*",
      network: sandboxNetwork(ctx.config.sandbox),
    };
  }
  const sid = sessionId ?? "default";
  const sessionGate = gateForSession(ctx, sid);
  const cached = sessionScopes.get(sid);
  if (cached)
    return {
      tools: sessionToolsFor(cached.tools, sessionGate),
      pathScopes: "*",
      network: sandboxNetwork(ctx.config.sandbox),
    };
  try {
    const scope = await getOrCreateScope(sid);
    return {
      tools: sessionToolsFor(scope.tools, sessionGate),
      pathScopes: "*",
      network: sandboxNetwork(ctx.config.sandbox),
    };
  } catch {
    return { tools: "*", pathScopes: "*", network: sandboxNetwork(ctx.config.sandbox) };
  }
}

export function buildSpawnTool(daemon: DaemonContext, scope: SessionScope): ToolsToolSpec {
  const {
    activeTurnMeta,
    adapterFor,
    catalogModel,
    config,
    createTraceRecorder,
    eventBus,
    gate,
    getKeychain,
    getOrCreateScope,
    http,
    identity,
    options,
    providers,
    redactor,
    schedulerFor,
    sessionScopes,
    todoSessionsDir,
    todoStore,
    warnPersistence,
  } = daemon;
  const spawnMaxDepth = (config as unknown as { spawn?: { maxDepth?: number } }).spawn?.maxDepth ?? 1;
  // An agent with a description is a type that the model can choose: the roster holds the files of the config folder and the workspace.
  type AgentType = {
    description?: string;
    provider?: string;
    model?: string;
    tools?: string[];
    systemPrompt?: string;
  };
  const agentTypes = Object.entries(
    (config as unknown as { agents?: Record<string, AgentType> }).agents ?? {},
  )
    .filter(([, agent]) => agent.description)
    .map(([name, agent]) => ({ ...agent, name, description: agent.description ?? "" }));
  return createSpawnTool({
    maxDepth: spawnMaxDepth,
    agentTypes,
    runTask: async (input, ctx) => {
      const agentType = agentTypes.find((type) => type.name === input.agent);
      if (input.agent !== undefined && agentType === undefined) {
        const names = agentTypes.map((type) => type.name).join(", ");
        const known = names ? `The types are: ${names}` : NO_AGENTS_MESSAGE;
        return { content: `unknown agent type: ${input.agent}. ${known}`, isError: true };
      }
      const parentTurnId = ctx.turnId;
      const parentSessionId = ctx.sessionId ?? "default";
      const meta = parentTurnId ? activeTurnMeta.get(parentTurnId) : undefined;
      const parentDepth = ctx.taskDepth ?? meta?.taskDepth ?? 0;
      const parentProvider = meta?.provider ?? "anthropic";
      const parentModel = meta?.model ?? "test-model";
      const parentApiKey = meta?.apiKey ?? "";
      const parentCaps = meta?.capabilities ?? {
        tools: "*",
        pathScopes: "*",
        network: sandboxNetwork(daemon.config.sandbox),
      };
      const parentTools = meta?.tools ?? scope.registry.list();

      let childProvider = agentType?.provider ?? parentProvider;
      let childModel = agentType?.model ?? parentModel;
      if (typeof input.model === "string" && input.model.length > 0) {
        const slash = input.model.indexOf("/");
        if (slash > 0) {
          childProvider = input.model.slice(0, slash);
          childModel = input.model.slice(slash + 1);
        } else {
          childModel = input.model;
        }
      }

      let childApiKey = parentApiKey;
      if (childProvider !== parentProvider) {
        let own: string | undefined;
        try {
          own = await resolveApiKey({
            provider: childProvider,
            env: process.env,
            keychain: await getKeychain(),
            config: providers[childProvider]?.apiKey,
            ...keySourcesFor(childProvider, providers),
          });
        } catch {}
        if (own) {
          childApiKey = own;
          redactor.registerSecret(own);
        } else {
          // No key for the requested provider: the parent's key must not go to another vendor.
          childProvider = parentProvider;
          childModel = parentModel;
        }
      }

      const childSessionId = newEntryId();
      const childTurnId = newEntryId();
      const startMs = Date.now();
      try {
        todoStore.create(childSessionId);
      } catch (error: unknown) {
        warnPersistence("todoStore.create", error);
      }
      try {
        const started = { sessionId: childSessionId, handle: agentType?.name ?? "worker", parentSessionId };
        eventBus.emit("subagent.start", started);
        eventBus.emit("event", { event: "subagent.start", payload: started });
      } catch {}
      await getOrCreateScope(childSessionId);

      // A worker has the permission mode of the run that started it: no more, and no less.
      const workerGate = gate.withMode(meta?.permissionMode ?? "ask");
      const baseTools = parentTools;
      const wantedTools =
        Array.isArray(input.tools) && input.tools.length > 0 ? input.tools : agentType?.tools;
      let childTools: ToolSpec[];
      if (wantedTools !== undefined) {
        const allow = new Set(wantedTools);
        // A tool list names its tools: a deferred MCP tool in it is loaded for the worker.
        childTools = baseTools
          .filter((t) => allow.has(t.name))
          .map((t) => ("hidden" in t ? { ...t, hidden: () => false } : t));
        if (!allow.has("spawn") && childTools.some((t) => t.name === "spawn")) {
          childTools = childTools.filter((t) => t.name !== "spawn");
        }
      } else {
        childTools = baseTools.filter((t) => workerGate.toolOffered(t.name, t.riskTier));
      }
      // Depth-0 child isolation: subagents cannot dispatch or spawn.
      childTools = childTools.filter((t) => t.name !== "dispatch" && t.name !== "spawn");

      const childCapTools = childTools.map((t) => t.name);
      const childCaps: Capabilities = {
        tools: childCapTools.length > 0 ? childCapTools : ("*" as const),
        pathScopes: parentCaps.pathScopes,
        network: parentCaps.network,
      };

      const workerPrompt = composeSystemPrompt({
        base:
          agentType?.systemPrompt ??
          "You are an ephemeral worker. Complete the given prompt concisely and return only the final result.",
        // The rules of the project hold for a worker too. Plugin and skill texts stay with the main turn.
        instructions: projectInstructions({
          workspaceRoot: options.workspaceRoot,
          trustStore: daemon.trustStore,
        }),
        toolDescriptions: [],
        // Without it a worker does not know its folder, its shell or the date.
        context: buildEnvironmentBlock(
          gatherEnvironmentInfo({ cwd: options.workspaceRoot, shell: daemon.shellLabel }),
        ),
      });

      const freshSession: Message[] = [{ role: "user", content: [{ type: "text", text: input.prompt }] }];

      const childModelInfo = catalogModel(childProvider, childModel);
      const childTurn = await runChildTurn(
        { http, eventBus, createTraceRecorder, redactToolResult: redactor.redactToolResult },
        {
          adapter: adapterFor(childProvider),
          scheduler: schedulerFor(childProvider),
          session: freshSession,
          systemPrompt: workerPrompt.text,
          systemSegments: workerPrompt.segments,
          tools: childTools,
          model: childModel,
          apiKey: childApiKey,
          provider: childProvider,
          identity,
          capabilities: childCaps,
          toolPolicy: workerGate,
          ...(ctx.requestApproval === undefined ? {} : { requestApproval: ctx.requestApproval }),
          reviewApproval: autoReviewerFor(daemon, meta?.permissionMode),
          budget: meta?.budget,
          ...modelRunOptions(childModelInfo),
          turnId: childTurnId,
          sessionId: childSessionId,
          cwd: options.workspaceRoot,
          taskDepth: parentDepth + 1,
          doomLoopDetection: true,
          signal: ctx.signal,
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
      const childEvents = childTurn.events;
      const childTraceRecorder = childTurn.traceRecorder;
      {
        const durationMs = Date.now() - startMs;
        const finalText = childResult ? extractFinalText(childResult.messages) : "";
        const collapsed =
          (finalText || (childError instanceof Error ? childError.message : String(childError ?? "")))
            .split("\n")[0]
            ?.slice(0, 500) ?? "";
        try {
          const parentLatestTip = todoStore.latestTip(todoStore.load(parentSessionId)) ?? null;
          await todoStore.append(parentSessionId, {
            type: "task_result",
            parentId: parentLatestTip,
            tool: "spawn",
            childSessionId,
            childTurnId,
            durationMs,
            summary: collapsed || finalText.slice(0, 500),
            prompt: input.prompt.slice(0, 200),
          });
        } catch (error: unknown) {
          warnPersistence("task_result append", error);
        }
        try {
          if (childResult) {
            let childParentId: string | null = null;
            const msgs = childResult.messages;
            for (const msg of msgs) {
              const appended = await todoStore.append(childSessionId, {
                type: "message",
                parentId: childParentId,
                message: msg,
              });
              childParentId = appended.id;
            }
          }
        } catch (error: unknown) {
          warnPersistence("child messages append", error);
        }
        try {
          if (childTraceRecorder && childResult && daemon.config.trace?.cassettes) {
            const rec = childTraceRecorder.toCassetteRecord(
              {
                provider: childProvider,
                model: childModel,
                systemPrompt: workerPrompt.text,
                session: freshSession,
              },
              childEvents,
              childResult,
            );
            await childTraceRecorder.writeCassette(childTurnId, rec);
          }
        } catch (error: unknown) {
          warnPersistence("cassette write", error);
        }
        try {
          const cs = sessionScopes.get(childSessionId);
          if (cs) {
            try {
              await cs.dispose();
            } catch {}
            sessionScopes.delete(childSessionId);
          }
        } catch {}
      }

      if (childError) {
        return {
          content: childError instanceof Error ? childError.message : String(childError),
          isError: true,
        };
      }
      const finalText = extractFinalText(childResult?.messages ?? []);
      // A worker that stopped early says so: the lead must not read partial work as a finished task.
      if (childResult?.error) {
        const why = `worker did not finish (${childResult.error.code}: ${childResult.error.message})`;
        return { content: finalText ? `${why}\n${finalText}` : why, isError: true };
      }
      return { content: finalText || "(no output)" };
    },
  });
}
