import { randomUUID } from "node:crypto";
import {
  compact,
  composeSystemPrompt,
  generateTitle,
  getSessionTitle,
  newEntryId,
  projectSessionView,
  resolveSmallModel,
  runChildTurn,
  summarizeTranscript,
  type ToolSpec,
} from "@agency/core";
import type { Capabilities, PermissionsGate } from "@agency/guard";
import { type KeychainBackend, pickCheapModel, resolveApiKey, tokenizerFor } from "@agency/providers";
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
import { handleForSession } from "../team-context.ts";
import {
  type DaemonContext,
  keySourcesFor,
  type RunTurnParams,
  type SessionMessageParams,
  type SessionSendParams,
  type SessionSendResult,
} from "../types.ts";
import { executeTurn, PROMPT_HOOK_SOURCE } from "./turn.ts";

/** Fallback window for daemon-side proactive compaction, matching the
 *  former client default until the catalog supplies a real one. */
const DEFAULT_SESSION_CONTEXT_WINDOW = 200_000;

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
              if (title) {
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
    const scope = sessionScopes.get(sessionId);
    if (scope) {
      try {
        await scope.dispose();
      } catch {}
      sessionScopes.delete(sessionId);
    }
    approvalManagers.delete(sessionId);
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
    if (!store.list().includes(p.sessionId)) store.create(p.sessionId);
    const family = providers[p.provider]?.family ?? p.provider;
    const tokenizer = tokenizerFor(family);
    // The model's own window, not a fixed guess: a small-window model overflows long before 200k tokens.
    const window = p.contextWindow ?? ctx.catalogModel(p.provider, p.model)?.contextWindow;
    const threshold = { contextWindow: window ?? DEFAULT_SESSION_CONTEXT_WINDOW };
    const summarize = (text: string): Promise<string> => Promise.resolve(summarizeTranscript(text));
    let tipId = store.latestTip(store.load(p.sessionId)) ?? null;
    let compacted = false;
    // undo_run restores this tip, so the whole turn (user text included) rolls back.
    const checkpoints = turnCheckpoints.get(p.sessionId) ?? [];
    checkpoints.push(tipId);
    turnCheckpoints.set(p.sessionId, checkpoints);
    if (tipId) {
      const outcome = await compact(store, p.sessionId, tipId, tokenizer, threshold, summarize);
      tipId = outcome.tipId;
      compacted = outcome.compacted;
    }
    const userEntry = await store.append(p.sessionId, {
      type: "message",
      parentId: tipId,
      message: { role: "user", content: [{ type: "text", text: p.userText }, ...(p.images ?? [])] },
    });
    let history = store.messagesFor(store.load(p.sessionId), userEntry.id);
    // Reactive compaction forks the branch, so new appends rebase onto
    // the compacted tip instead of the orphaned pre-compaction entry.
    let tip: string | null = userEntry.id;
    const onContextOverflow = async (): Promise<Message[]> => {
      // From the current tip, not the prompt: the steps this turn has done stay in the model's view.
      const from = tip ?? userEntry.id;
      const outcome = await compact(store, p.sessionId, from, tokenizer, threshold, summarize, 4, {
        force: true,
      });
      history = store.messagesFor(store.load(p.sessionId), outcome.tipId);
      tip = outcome.tipId;
      compacted = true;
      return history;
    };
    const turnId = p.turnId ?? randomUUID();
    const runParams: RunTurnParams = {
      turnId,
      sessionId: p.sessionId,
      provider: p.provider,
      model: p.model,
      systemPrompt: p.systemPrompt,
      systemPromptParts: p.systemPromptParts,
      thinkingLevel: p.thinkingLevel,
      session: history,
      budget: p.budget ?? sessionBudgets.get(p.sessionId),
      permissionMode: p.permissionMode,
      maxToolIterations: p.maxToolIterations,
      nonInteractive: p.nonInteractive,
      ...(p.images?.length ? { images: p.images } : {}),
    };
    // Each message is stored as the turn produces it: a failed turn or a dead daemon keeps the finished steps.
    const onMessage = async (message: Message): Promise<void> => {
      tip = (await store.append(p.sessionId, { type: "message", parentId: tip, message })).id;
    };
    const hooks = { onContextOverflow, onMessage };
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
    const parentId = await appendUsageEntry(store, p.sessionId, tip, {
      usage: result.usage,
      model: served.model,
      pricing: ctx.catalogModel(served.provider, served.model)?.pricing,
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
    const box = sessionInboxes.get(sessionId) ?? [];
    sessionInboxes.set(sessionId, box);
    box.push({ role: "user", content: [{ type: "text", text }] });
    broadcast(`session.${sessionId}`, { type: "session_message", sessionId });
    return { queued: true, depth: box.length };
  };
}

export function sessionToolsFor(list: ToolSpec[], offerGate: PermissionsGate): readonly string[] | "*" {
  const offered = list.filter((t) => offerGate.toolOffered(t.name, t.riskTier));
  return offered.length === list.length ? ("*" as const) : offered.map((t) => t.name);
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
    return { tools: sessionToolsFor(tools, gate), pathScopes: "*", network: "*" };
  }
  const sid = sessionId ?? "default";
  const sessionGate = gateForSession(ctx, sid);
  const cached = sessionScopes.get(sid);
  if (cached) return { tools: sessionToolsFor(cached.tools, sessionGate), pathScopes: "*", network: "*" };
  try {
    const scope = await getOrCreateScope(sid);
    return { tools: sessionToolsFor(scope.tools, sessionGate), pathScopes: "*", network: "*" };
  } catch {
    return { tools: "*", pathScopes: "*", network: "*" };
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
  return createSpawnTool({
    maxDepth: spawnMaxDepth,
    runTask: async (input, ctx) => {
      const parentTurnId = ctx.turnId;
      const parentSessionId = ctx.sessionId ?? "default";
      const meta = parentTurnId ? activeTurnMeta.get(parentTurnId) : undefined;
      const parentDepth = ctx.taskDepth ?? meta?.taskDepth ?? 0;
      const parentProvider = meta?.provider ?? "anthropic";
      const parentModel = meta?.model ?? "test-model";
      const parentApiKey = meta?.apiKey ?? "";
      const parentCaps = meta?.capabilities ?? { tools: "*", pathScopes: "*", network: "*" as const };
      const parentTools = meta?.tools ?? scope.registry.list();

      let childProvider = parentProvider;
      let childModel = parentModel;
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
      await getOrCreateScope(childSessionId);

      const baseTools = parentTools;
      let childTools: ToolSpec[];
      if (Array.isArray(input.tools) && input.tools.length > 0) {
        const allow = new Set(input.tools);
        childTools = baseTools.filter((t) => allow.has(t.name));
        if (!allow.has("spawn") && childTools.some((t) => t.name === "spawn")) {
          childTools = childTools.filter((t) => t.name !== "spawn");
        }
      } else {
        childTools = baseTools.filter((t) => gate.toolOffered(t.name, t.riskTier));
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
        base: "You are an ephemeral worker. Complete the given prompt concisely and return only the final result.",
        instructions: [],
        toolDescriptions: [],
      });

      const freshSession: Message[] = [{ role: "user", content: [{ type: "text", text: input.prompt }] }];

      const childModelInfo = catalogModel(childProvider, childModel);
      const childTurn = await runChildTurn(
        { http, eventBus, createTraceRecorder },
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
          toolPolicy: gate,
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
          if (childTraceRecorder && childResult) {
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
