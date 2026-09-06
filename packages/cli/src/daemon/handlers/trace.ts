import {
  buildSpanTree,
  type LoopEvent,
  loadTraceSpansSync,
  type RunTurnResult,
  readCassetteRecord,
  runTurn,
  spansToOtlp,
  type TraceRecorder,
} from "@agency/core";
import { type KeychainBackend, resolveApiKey, type ThinkingLevel } from "@agency/providers";
import type { MethodHandler } from "@agency/rpc";
import { AgencyError, ErrorCode } from "@agency/schema";
import { type DaemonContext, oauthOverridesFor, type RunTurnParams } from "../types.ts";

export function writeTurnCassette(
  traceRecorder: TraceRecorder,
  params: RunTurnParams,
  sysPrompt: string,
  events: LoopEvent[],
  result: RunTurnResult,
): void {
  const record = traceRecorder.toCassetteRecord(
    {
      provider: params.provider,
      model: params.model,
      systemPrompt: sysPrompt,
      session: params.session,
    },
    events,
    result,
  );
  void traceRecorder.writeCassette(params.turnId, record);
}

export function registerTraceHandlers(handlers: Record<string, MethodHandler>, ctx: DaemonContext): void {
  const {
    adapterFor,
    builtinsMode,
    config,
    defaultCapabilitiesForSession,
    defaultCapabilitiesSync,
    eventBus,
    gate,
    getKeychain,
    http,
    identity,
    options,
    providers,
    schedulerFor,
    sessionScopes,
    todoSessionsDir,
    tools,
  } = ctx;
  handlers.trace_get = async (rawParams) => {
    const { sessionId, turnId } = rawParams as { sessionId: string; turnId?: string };
    if (!sessionId)
      throw new AgencyError(ErrorCode.INTERNAL, "trace_get requires sessionId", { source: "trace" });
    const spans = loadTraceSpansSync(todoSessionsDir, sessionId);
    const filtered = turnId ? spans.filter((s) => s.traceId === turnId) : spans;
    const tree = buildSpanTree(filtered);
    return { spans: filtered, tree };
  };
  handlers.trace_replay = async (rawParams) => {
    const { sessionId, turnId, overrides } = rawParams as {
      sessionId: string;
      turnId: string;
      overrides?: {
        model?: string;
        provider?: string;
        thinkingLevel?: ThinkingLevel;
        systemPrompt?: string;
        effort?: string;
      };
    };
    if (!sessionId || !turnId)
      throw new AgencyError(ErrorCode.INTERNAL, "trace_replay requires sessionId and turnId", {
        source: "trace",
      });
    const record = await readCassetteRecord(todoSessionsDir, sessionId, turnId);
    if (!record)
      throw new AgencyError(ErrorCode.INTERNAL, `no cassette for ${sessionId}/${turnId}`, {
        source: "trace",
      });
    const targetProvider = overrides?.provider ?? record.params.provider;
    const targetModel = overrides?.model ?? record.params.model;
    const targetSystemPrompt = overrides?.systemPrompt ?? record.params.systemPrompt;
    const thinkingLevel = overrides?.thinkingLevel;
    const targetAdapter = adapterFor(targetProvider);
    const targetScheduler = schedulerFor(targetProvider);
    const replayCaps = builtinsMode
      ? await defaultCapabilitiesForSession(sessionId)
      : defaultCapabilitiesSync;
    const replayTools = builtinsMode
      ? ((sessionScopes.get(sessionId) ?? [...sessionScopes.values()][0])?.tools.filter((t) =>
          gate.toolOffered(t.name, t.riskTier),
        ) ?? tools.filter((t) => gate.toolOffered(t.name, t.riskTier)))
      : tools.filter((t) => gate.toolOffered(t.name, t.riskTier));
    const replayed = await runTurn(targetAdapter, targetScheduler, http, {
      identity,
      capabilities: replayCaps,
      toolPolicy: gate,
      eventBus,
      systemPrompt: targetSystemPrompt,
      tools: replayTools,
      model: targetModel,
      apiKey: await (async () => {
        const k = await (async () => {
          let kc: KeychainBackend | undefined;
          try {
            kc = await getKeychain();
          } catch {}
          return resolveApiKey({
            provider: targetProvider,
            env: process.env,
            keychain: kc,
            config: providers[targetProvider]?.apiKey,
            ...oauthOverridesFor(targetProvider, providers),
          });
        })();
        return k ?? "replay-key";
      })(),
      thinkingLevel: thinkingLevel as ThinkingLevel | undefined,
      session: record.params.session,
      cwd: options.workspaceRoot,
      maxToolIterations: 25,
    });
    const equal = JSON.stringify(replayed.messages) === JSON.stringify(record.result.messages);
    return { equal, original: record, replayed };
  };
  handlers.trace_export = async (rawParams) => {
    const { sessionId, turnId } = rawParams as { sessionId: string; turnId?: string };
    const exportCfg = (
      config as unknown as { trace?: { export?: { endpoint: string; headers?: Record<string, string> } } }
    ).trace?.export;
    if (!exportCfg?.endpoint) return { exported: false, reason: "not configured" };
    const spans = loadTraceSpansSync(todoSessionsDir, sessionId ?? "");
    const filtered = turnId ? spans.filter((s) => s.traceId === turnId) : spans;
    if (filtered.length === 0) return { exported: false, reason: "no spans" };
    const payload = spansToOtlp(filtered);
    try {
      await fetch(exportCfg.endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(exportCfg.headers ?? {}) },
        body: JSON.stringify(payload),
      });
    } catch (error) {
      throw new AgencyError(
        ErrorCode.INTERNAL,
        `trace export failed: ${error instanceof Error ? error.message : String(error)}`,
        { source: "trace" },
      );
    }
    return { exported: true, endpoint: exportCfg.endpoint };
  };
}
