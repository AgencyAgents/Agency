import type { CallerIdentity, Capabilities, ToolPolicy } from "@agency/guard";
import type { HttpClient } from "@agency/net";
import type { CacheSegment, ProviderAdapter, Scheduler } from "@agency/providers";
import type { Message } from "@agency/schema";
import {
  type Budget,
  type LoopEvent,
  type PricePerMTok,
  type RunTurnOptions,
  type RunTurnResult,
  runTurn,
  type ToolSpec,
} from "../loop.ts";
import type { TraceRecorder } from "../trace/recorder.ts";

export interface ChildTurnTrace {
  sessionsDir: string;
  sessionId: string;
  traceId: string;
  provider: string;
  model: string;
}

export interface ChildTurnSpec {
  adapter: ProviderAdapter;
  scheduler: Scheduler;
  session: Message[];
  systemPrompt: string;
  systemSegments?: CacheSegment[];
  tools: ToolSpec[];
  model: string;
  apiKey: string;
  provider: string;
  identity: CallerIdentity;
  capabilities: Capabilities;
  toolPolicy: ToolPolicy;
  budget?: Budget;
  pricePerMTok?: PricePerMTok;
  maxTokensPerRequest?: number;
  turnId: string;
  sessionId: string;
  cwd: string;
  taskDepth: number;
  doomLoopDetection?: boolean;
  drainMailbox?: () => Message[];
  signal?: AbortSignal;
  trace?: ChildTurnTrace;
}

export interface ChildTurnDeps {
  http: HttpClient;
  eventBus?: RunTurnOptions["eventBus"];
  createTraceRecorder: (trace: ChildTurnTrace) => TraceRecorder | undefined;
}

export interface ChildTurnOutcome {
  result?: RunTurnResult;
  error?: unknown;
  events: LoopEvent[];
  traceRecorder?: TraceRecorder;
}

/** Single child-turn assembly for spawn, dispatch, and dispatch_compare. */
export async function runChildTurn(deps: ChildTurnDeps, spec: ChildTurnSpec): Promise<ChildTurnOutcome> {
  const events: LoopEvent[] = [];
  const traceRecorder = spec.trace ? deps.createTraceRecorder(spec.trace) : undefined;
  try {
    const result = await runTurn(spec.adapter, spec.scheduler, deps.http, {
      identity: spec.identity,
      capabilities: spec.capabilities,
      toolPolicy: spec.toolPolicy,
      eventBus: deps.eventBus,
      systemPrompt: spec.systemPrompt,
      ...(spec.systemSegments !== undefined ? { systemSegments: spec.systemSegments } : {}),
      tools: spec.tools,
      model: spec.model,
      apiKey: spec.apiKey,
      provider: spec.provider,
      traceRecorder,
      session: spec.session,
      ...(spec.budget !== undefined ? { budget: spec.budget } : {}),
      ...(spec.pricePerMTok !== undefined ? { pricePerMTok: spec.pricePerMTok } : {}),
      ...(spec.maxTokensPerRequest !== undefined ? { maxTokensPerRequest: spec.maxTokensPerRequest } : {}),
      turnId: spec.turnId,
      sessionId: spec.sessionId,
      cwd: spec.cwd,
      taskDepth: spec.taskDepth,
      doomLoopDetection: spec.doomLoopDetection ?? true,
      ...(spec.signal !== undefined ? { signal: spec.signal } : {}),
      ...(spec.drainMailbox !== undefined ? { drainMailbox: spec.drainMailbox } : {}),
      onEvent: (ev) => {
        events.push(ev);
      },
    });
    return { result, events, ...(traceRecorder !== undefined ? { traceRecorder } : {}) };
  } catch (error) {
    return { error, events, ...(traceRecorder !== undefined ? { traceRecorder } : {}) };
  }
}
