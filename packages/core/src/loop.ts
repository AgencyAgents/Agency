import type {
  ApprovalRequest,
  CallerIdentity,
  Capabilities,
  RequestApproval,
  RiskTier,
  ToolPolicy,
} from "@agency/guard";
import { isCommandPatternTool, isPathPatternTool, requireTool } from "@agency/guard";
import type { HttpClient } from "@agency/net";
import {
  type ProviderAdapter,
  type Scheduler,
  selectModel,
  type ThinkingLevel,
  type ToolDefinition,
  type Usage,
  withCheapFallback,
  withMidStreamRecovery,
} from "@agency/providers";
import type { ContentBlock, ImageBlock, Message, StopReason } from "@agency/schema";
import { isContextOverflowError } from "./sessions/compaction.ts";
import type { TraceRecorder } from "./trace/recorder.ts";
import { truncateToolResults } from "./truncate.ts";

export type ToolHandler = (
  input: Record<string, unknown>,
  ctx: {
    signal: AbortSignal;
    turnId?: string;
    cwd?: string;
    sessionId?: string;
    /** Agent handle active for this call, derived from the turn identity. */
    agentHandle?: string;
    toolCallId?: string;
    requestApproval?: RequestApproval;
    onProgress?: (message: string) => void;
  },
) => Promise<{ content: string; isError?: boolean; images?: ImageBlock[] }>;

export interface ToolSpec extends ToolDefinition {
  handler: ToolHandler;
  /** How risky this tool is by nature; the permission gate and the trust
   *  gate both consume it (`safe` runs freely, the rest asks and needs a
   *  trusted workspace). Unclassified tools are treated as ungated. */
  riskTier?: RiskTier;
}

export interface Budget {
  maxTokens?: number;
  maxCostUsd?: number;
}

export interface PricePerMTok {
  input: number;
  output: number;
}

export type LoopEvent =
  | { type: "text_delta"; text: string }
  | { type: "thinking_delta"; text: string }
  | { type: "tool_start"; id: string; name: string; input?: Record<string, unknown> }
  | { type: "tool_result"; id: string; content: string; isError: boolean; images?: ImageBlock[] }
  | { type: "tool_progress"; id: string; name: string; message: string }
  | { type: "turn_complete"; stopReason: StopReason; usage: Usage }
  | { type: "budget_exceeded"; spentTokens: number; spentCostUsd: number }
  | { type: "iteration_limit"; iterations: number }
  | { type: "error"; code: string; message: string }
  | { type: "retry"; attempt: number; message: string; next?: number }
  | { type: "model_route"; model: string; routed: "cheap" | "primary"; tag: string };

export interface RunTurnOptions {
  identity: CallerIdentity;
  capabilities: Capabilities;
  systemPrompt: string;
  tools: ToolSpec[];
  model: string;
  apiKey: string;
  thinkingLevel?: ThinkingLevel;
  session: Message[];
  budget?: Budget;
  pricePerMTok?: PricePerMTok;
  maxTokensPerRequest?: number;
  drainMailbox?: () => Message[];
  /** Orchestra control (B3): detects identical tool+input 3x consecutively and
   *  halts the turn. Opt-in — enabled for dispatched peers only. */
  doomLoopDetection?: boolean;
  /** Correlates tool invocations with the turn that caused them (snapshot
   *  journaling for undo); passed through to tool handler contexts. */
  turnId?: string;
  /** Session this turn belongs to; threaded into tool contexts so session-scoped
   *  approvals (the "always" grants) can be attributed. */
  sessionId?: string;
  /** Workspace directory, threaded into tool contexts for path resolution. */
  cwd?: string;
  /**
   * Approval surface for `ask` decisions and tool-initiated requests. Absent
   * means every ask fails closed (deny) — a headless run never self-approves.
   */
  requestApproval?: RequestApproval;
  /**
   * The permissions gate consulted before each tool handler runs: `deny`
   * produces a per-call error without invoking the handler, `ask` routes
   * through `requestApproval`. Absent = no permission enforcement.
   */
  toolPolicy?: ToolPolicy;
  /** Caps tool-calling round-trips even when nothing else stops the run:
   *  a runaway model that keeps calling tools shouldn't spin forever. */
  maxToolIterations?: number;
  signal?: AbortSignal;
  onEvent?: (event: LoopEvent) => void;
  eventBus?: {
    emit: (event: string, payload: unknown) => void;
    emitAsync?: (event: string, payload: unknown) => Promise<void>;
    emitCollect?: (event: string, payload: unknown) => Promise<{ errors: unknown[] }>;
  };
  /** Overflow hook (U8): runs once per turn on context overflow, then the
   *  provider call is retried exactly once. Absent means overflow throws. */
  onContextOverflow?: () => Promise<void>;
  /** Prompt version tag for trace attribution (systemPromptParts identity/role version or caller-supplied). */
  promptVersion?: string;
  /** Optional trace recorder: when present runTurn emits turn/model/tool spans. */
  traceRecorder?: TraceRecorder;
  /** Provider identifier for the model (e.g. "anthropic"), used for trace attribution. */
  provider?: string;
  /** Depth of nested task invocations (0 for root, incremented per child). */
  taskDepth?: number;
  /** Task category for cheap-model routing (title, summary, background go cheap). */
  taskKind?: string;
  /** Cheap model id; when set with an eligible taskKind the turn routes cheap. */
  cheapModel?: string;
  /** Explicit override; when true the primary model always wins. */
  forcePrimary?: boolean;
}

const NEVER_ABORTED = new AbortController().signal;

/** Approval prompt for a tripped doom loop. Asks instead of spinning. */
export function doomApprovalRequest(toolName: string, repeats: number): ApprovalRequest {
  return {
    tool: "doom-loop",
    title: `doom loop detected: ${toolName} repeated ${repeats}x consecutively. Continue anyway?`,
    metadata: { toolName, repeats },
  };
}

export interface RunTurnResult {
  messages: Message[];
  stopReason: StopReason;
  usage: Usage;
  budgetExceeded: boolean;
}

/**
 * The R4 seam: no globals, every dependency passed in, so a second concurrent
 * loop (a future teammate agent) is additive rather than a rewrite. One call
 * drives a full turn, including any tool-calling round-trips it takes to
 * reach a non-tool_use stop reason, a budget breach, or the iteration cap.
 */
export async function runTurn(
  adapter: ProviderAdapter,
  scheduler: Scheduler,
  http: HttpClient,
  options: RunTurnOptions,
): Promise<RunTurnResult> {
  const messages = [...options.session];
  const maxToolIterations = options.maxToolIterations ?? 25;
  const toolDefs: ToolDefinition[] = options.tools.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema,
  }));

  let cumulativeUsage: Usage = { inputTokens: 0, outputTokens: 0 };
  let spentCostUsd = 0;
  let stopReason: StopReason = "end_turn";
  const tracer = options.traceRecorder;
  const turnSpanId = tracer
    ? tracer.startTurnSpan({
        provider: options.provider,
        model: options.model,
        promptVersion: options.promptVersion,
      })
    : null;
  const endTurnOk = () => {
    if (tracer && turnSpanId) {
      try {
        tracer.endTurnSpan(options.signal?.aborted ? "cancelled" : "ok", {
          inputTokens: cumulativeUsage.inputTokens,
          outputTokens: cumulativeUsage.outputTokens,
          ...(cumulativeUsage.cachedInputTokens !== undefined
            ? { cachedInputTokens: cumulativeUsage.cachedInputTokens }
            : {}),
          cost: spentCostUsd,
        });
      } catch {}
      try {
        tracer.flushAsync();
      } catch {}
    }
  };
  const endTurnError = () => {
    if (tracer && turnSpanId) {
      try {
        tracer.endTurnSpan("error");
      } catch {}
      try {
        tracer.flushAsync();
      } catch {}
    }
  };

  // Doom-loop detection is an orchestra control (B3): opt-in per turn, enabled for
  // dispatched peers. The solo room keeps its existing semantics — a runaway
  // loop is capped by maxToolIterations, not by input-identity heuristics.
  const doomHistory: string[] = [];
  const doomDetection = options.doomLoopDetection === true;
  const routeSelection = selectModel(options.model, options.cheapModel, {
    ...(options.taskKind !== undefined ? { kind: options.taskKind } : {}),
    ...(options.forcePrimary !== undefined ? { forcePrimary: options.forcePrimary } : {}),
  });
  const routingActive = options.cheapModel !== undefined;
  if (routingActive) {
    options.onEvent?.({
      type: "model_route",
      model: routeSelection.model,
      routed: routeSelection.routed,
      tag: routeSelection.tag,
    });
  }
  const collectWithFallback = async (): Promise<CollectedTurn> => {
    const runOne = (model: string): Promise<CollectedTurn> =>
      scheduler.schedule(
        () =>
          collectTurn(
            adapter,
            http,
            {
              model,
              apiKey: options.apiKey,
              system: options.systemPrompt,
              messages,
              tools: toolDefs,
              maxTokens: options.maxTokensPerRequest ?? 8192,
              thinkingLevel: options.thinkingLevel,
              signal: options.signal,
            },
            options.onEvent,
          ),
        {
          onRetry: (attempt, message, next) => {
            options.onEvent?.({ type: "retry", attempt, message, next });
          },
        },
      );
    if (!routingActive || routeSelection.routed !== "cheap") {
      return runOne(options.model);
    }
    const routed = await withCheapFallback(routeSelection, options.model, runOne);
    if (routed.fellBack) {
      options.onEvent?.({ type: "model_route", model: routed.model, routed: "primary", tag: routed.tag });
    }
    return routed.value;
  };
  let overflowRetried = false;
  for (let iteration = 0; iteration < maxToolIterations; iteration++) {
    if (options.drainMailbox) {
      try {
        const injected = options.drainMailbox();
        if (injected.length > 0) messages.push(...injected);
      } catch {}
    }
    let modelSpanId: string | null = null;
    if (tracer && turnSpanId) {
      modelSpanId = tracer.startModelSpan(turnSpanId, {
        model: options.model,
        provider: options.provider ?? "unknown",
        promptVersion: options.promptVersion,
      });
    }
    try {
      let turn: CollectedTurn;
      try {
        turn = await collectWithFallback();
      } catch (error) {
        if (overflowRetried || !isContextOverflowError(error) || !options.onContextOverflow) throw error;
        overflowRetried = true;
        await options.onContextOverflow();
        options.onEvent?.({
          type: "retry",
          attempt: 1,
          message: "context overflow: compacted, retrying once",
        });
        turn = await collectWithFallback();
      }

      messages.push({ role: "assistant", content: turn.content });
      cumulativeUsage = addUsage(cumulativeUsage, turn.usage);
      const turnCost = costOf(turn.usage, options.pricePerMTok);
      spentCostUsd += turnCost;
      stopReason = turn.stopReason;
      options.onEvent?.({ type: "turn_complete", stopReason, usage: turn.usage });
      if (tracer && modelSpanId) {
        tracer.endSpan(modelSpanId, {
          status: turn.stopReason === "error" ? "error" : "ok",
          attributes: {
            inputTokens: turn.usage.inputTokens,
            outputTokens: turn.usage.outputTokens,
            cachedInputTokens: turn.usage.cachedInputTokens,
            cost: turnCost,
          },
        });
        modelSpanId = null;
      }

      const toolCalls = turn.content.filter(
        (b): b is Extract<ContentBlock, { type: "tool_call" }> => b.type === "tool_call",
      );

      if (exceedsBudget(cumulativeUsage, spentCostUsd, options.budget)) {
        if (toolCalls.length > 0 && !options.signal?.aborted) {
          const results = await runTools(toolCalls, options, turn.malformedCalls, options.signal);
          messages.push({ role: "user", content: results });
        }
        options.onEvent?.({
          type: "budget_exceeded",
          spentTokens: totalTokens(cumulativeUsage),
          spentCostUsd,
        });
        endTurnOk();
        return { messages, stopReason, usage: cumulativeUsage, budgetExceeded: true };
      }

      if (stopReason !== "tool_use" || options.signal?.aborted) break;

      for (const tc of toolCalls) {
        if (!doomDetection) break;
        const key = `${tc.name}:${JSON.stringify(tc.input)}`;
        doomHistory.push(key);
        if (doomHistory.length >= 3) {
          const last3 = doomHistory.slice(-3);
          if (last3[0] === last3[1] && last3[1] === last3[2]) {
            const doomError = Object.assign(new Error(`doom loop: ${tc.name} repeated 3x consecutively`), {
              code: "doom_loop",
            });
            options.onEvent?.({
              type: "error",
              code: "doom_loop",
              message: `doom loop detected: ${tc.name} repeated 3x`,
            });
            if (options.requestApproval) {
              const response = await options.requestApproval(doomApprovalRequest(tc.name, 3));
              if (response !== "reject") {
                doomHistory.length = 0;
                break;
              }
            }
            throw doomError;
          }
        }
      }
      const results = await runTools(toolCalls, options, turn.malformedCalls, options.signal);
      messages.push({ role: "user", content: results });
    } catch (error) {
      if (tracer && modelSpanId) {
        try {
          tracer.endSpan(modelSpanId, { status: "error" });
        } catch {}
      }
      endTurnError();
      emitErrorEvent(error, options.onEvent);
      throw error;
    }
  }

  if (stopReason === "tool_use" && !options.signal?.aborted) {
    options.onEvent?.({ type: "iteration_limit", iterations: maxToolIterations });
  }

  endTurnOk();
  return { messages, stopReason, usage: cumulativeUsage, budgetExceeded: false };
}

/** AgencyError-like errors carry a string `code`; anything else is reported as internal. */
function emitErrorEvent(error: unknown, onEvent?: (event: LoopEvent) => void): void {
  if (error instanceof Error) {
    const code = "code" in error && typeof error.code === "string" ? error.code : "internal";
    onEvent?.({ type: "error", code, message: error.message });
    return;
  }
  onEvent?.({ type: "error", code: "internal", message: String(error) });
}

type ToolResultLike = { content: string; isError: boolean; images?: ImageBlock[] };

interface ToolCallItem {
  call: Extract<ContentBlock, { type: "tool_call" }>;
  index: number;
  /** Pre-parsed per-call error for a call whose arguments never repaired. */
  malformed?: string;
  spec?: ToolSpec;
}

/**
 * True when a call can run beside its neighbors without ordering hazards:
 * safe-tier tools (reads) and calls with no handler to run (malformed
 * arguments, unknown tools — both resolve to fixed error results). Anything
 * mutating, unclassified, or unknown-risk runs alone, in call order.
 */
function parallelSafe(spec: ToolSpec | undefined, malformed: string | undefined): boolean {
  if (malformed !== undefined) return true;
  if (spec === undefined) return true;
  return spec.riskTier === "safe";
}

async function runTools(
  calls: Extract<ContentBlock, { type: "tool_call" }>[],
  options: RunTurnOptions,
  malformedCalls: ReadonlyMap<string, string>,
  signal: AbortSignal | undefined,
): Promise<ContentBlock[]> {
  const results: Array<Extract<ContentBlock, { type: "tool_result" }>> = new Array(calls.length);

  // Consecutive safe calls batch into one concurrent run; the first unsafe
  // call (or an interleaved one) flushes the batch, so a read sandwiched
  // between two writes still observes the writes in model order.
  const batches: ToolCallItem[][] = [];
  let pending: ToolCallItem[] = [];
  calls.forEach((call, index) => {
    const malformed = malformedCalls.get(call.id);
    const spec = resolveToolSpec(options.tools, call.name);
    if (!parallelSafe(spec, malformed)) {
      if (pending.length > 0) batches.push(pending);
      pending = [];
      batches.push([
        { call, index, ...(malformed !== undefined ? { malformed } : {}), ...(spec ? { spec } : {}) },
      ]);
      return;
    }
    pending.push({
      call,
      index,
      ...(malformed !== undefined ? { malformed } : {}),
      ...(spec ? { spec } : {}),
    });
  });
  if (pending.length > 0) batches.push(pending);

  const emit = (callId: string, result: ToolResultLike): void => {
    options.onEvent?.({
      type: "tool_result",
      id: callId,
      content: result.content,
      isError: result.isError,
      images: result.images,
    });
  };

  const store = (item: ToolCallItem, result: ToolResultLike): void => {
    results[item.index] = {
      type: "tool_result",
      toolCallId: item.call.id,
      content: result.content,
      isError: result.isError,
      ...(result.images?.length ? { images: result.images } : {}),
    };
  };

  for (const batch of batches) {
    if (signal?.aborted) {
      for (const item of batch) {
        const cancelled: ToolResultLike = {
          content: "[cancelled: turn aborted before this tool ran]",
          isError: true,
        };
        const t = options.traceRecorder;
        if (t) {
          const sid = t.startToolSpan(t.getTurnSpanId(), { toolName: item.call.name });
          t.endSpan(sid, { status: "cancelled", attributes: { isError: true } });
        }
        emit(item.call.id, cancelled);
        store(item, cancelled);
      }
      continue;
    }

    const settled = await Promise.all(
      batch.map(async (item): Promise<{ item: ToolCallItem; result: ToolResultLike }> => {
        const t = options.traceRecorder;
        const spanId = t ? t.startToolSpan(t.getTurnSpanId(), { toolName: item.call.name }) : null;
        let result: ToolResultLike;
        try {
          result = item.malformed
            ? { content: item.malformed, isError: true }
            : await executeOne(item.spec, item.call, options, signal);
        } catch (error) {
          result = { content: error instanceof Error ? error.message : String(error), isError: true };
        }
        if (t && spanId) {
          t.endSpan(spanId, {
            status: result.isError ? "error" : "ok",
            attributes: { isError: result.isError },
          });
        }
        return { item, result };
      }),
    );
    for (const { item, result } of settled) {
      emit(item.call.id, result);
      store(item, result);
    }
  }

  // The event above streams full content to the TUI; only the conversation is capped.
  return truncateToolResults(results);
}

function resolveToolSpec(tools: ToolSpec[], name: string): ToolSpec | undefined {
  const exact = tools.find((t) => t.name === name);
  if (exact) return exact;
  // Tool-call repair: providers occasionally mangle tool-name casing; fall back to a
  // case-insensitive match. Mismatch repair for "${name}" is silent by design (no log dependency).
  return tools.find((t) => t.name.toLowerCase() === name.toLowerCase());
}

async function executeOne(
  spec: ToolSpec | undefined,
  call: Extract<ContentBlock, { type: "tool_call" }>,
  options: RunTurnOptions,
  signal: AbortSignal | undefined,
): Promise<{ content: string; isError: boolean; images?: ImageBlock[] }> {
  const resolved = spec ?? resolveToolSpec(options.tools, call.name);
  if (!resolved) {
    const available = options.tools.map((t) => t.name).join(", ");
    return { content: `no such tool: "${call.name}" (available: ${available})`, isError: true };
  }

  try {
    requireTool(options.identity, options.capabilities, resolved.name);
  } catch (error) {
    return { content: error instanceof Error ? error.message : String(error), isError: true };
  }

  // Validate the model's arguments against the tool's declared schema BEFORE
  // anything runs: `{path: 123}` must die as a clean per-call error here, not
  // surface later as a raw TypeError out of a file operation.
  const validationError = validateToolInput(resolved.inputSchema, call.input);
  if (validationError) {
    return { content: validationError, isError: true };
  }

  if (options.eventBus && resolved.name === "bash") {
    try {
      const envPayload = { env: {} as Record<string, string> };
      options.eventBus.emit("shell.env", envPayload);
      options.eventBus.emit("event", { event: "shell.env", payload: envPayload });
    } catch {}
  }

  // Permission gate: deny (or a rejected ask) becomes a per-call error result;
  // the handler never runs. A tool absent from the caller's capability set is
  // already refused above; this layer is the per-subject policy.
  if (options.toolPolicy) {
    const subject: { command?: string; path?: string } = {};
    if (typeof call.input.command === "string" && isCommandPatternTool(resolved.name)) {
      subject.command = call.input.command;
    }
    if (typeof call.input.path === "string" && isPathPatternTool(resolved.name)) {
      subject.path = call.input.path;
    }
    try {
      const bus = options.eventBus;
      if (bus) {
        try {
          bus.emit("permission.asked", {
            tool: resolved.name,
            command: subject.command,
            path: subject.path,
            decision: "ask",
          });
          bus.emit("event", {
            event: "permission.asked",
            payload: { tool: resolved.name, command: subject.command, path: subject.path },
          });
        } catch {}
      }
      const verdict = await options.toolPolicy.check(
        { tool: resolved.name, riskTier: resolved.riskTier, ...subject },
        options.requestApproval,
      );
      if (bus) {
        try {
          bus.emit("permission.replied", {
            tool: resolved.name,
            command: subject.command,
            path: subject.path,
            decision: verdict,
          });
          bus.emit("event", {
            event: "permission.replied",
            payload: { tool: resolved.name, command: subject.command, path: subject.path, decision: verdict },
          });
        } catch {}
      }
      if (verdict === "deny") {
        return {
          content: `permission denied: ${resolved.name} is not permitted by the current permissions policy`,
          isError: true,
        };
      }
    } catch (error) {
      return { content: error instanceof Error ? error.message : String(error), isError: true };
    }
  }

  if (options.eventBus) {
    const payload = {
      tool: resolved.name,
      input: call.input,
      sessionId: options.sessionId,
      turnId: options.turnId,
    };
    try {
      if (options.eventBus.emitCollect) {
        const { errors } = await options.eventBus.emitCollect("tool.execute.before", payload);
        if (errors.length > 0) {
          const first = errors[0];
          return { content: first instanceof Error ? first.message : String(first), isError: true };
        }
      } else if (options.eventBus.emitAsync) {
        await options.eventBus.emitAsync("tool.execute.before", payload);
      } else {
        options.eventBus.emit("tool.execute.before", payload);
      }
    } catch {}
    options.eventBus.emit("event", { event: "tool.execute.before", payload });
  }

  const toolSignal = signal ?? NEVER_ABORTED;
  const onEvent = options.onEvent;
  const toolCtx = {
    signal: toolSignal,
    turnId: options.turnId,
    cwd: options.cwd,
    sessionId: options.sessionId,
    agentHandle: options.identity.type === "agent" ? options.identity.name : undefined,
    toolCallId: call.id,
    requestApproval: options.requestApproval,
    taskDepth: options.taskDepth,
    onProgress: onEvent
      ? (message: string) => {
          onEvent({ type: "tool_progress", id: call.id, name: resolved.name, message });
        }
      : undefined,
  };
  let result: { content: string; isError?: boolean; images?: ImageBlock[] };
  try {
    result = await resolved.handler(call.input, toolCtx);
  } catch (error) {
    result = { content: error instanceof Error ? error.message : String(error), isError: true };
  }

  if (options.eventBus) {
    const afterPayload = {
      tool: resolved.name,
      input: call.input,
      result: { content: result.content, isError: result.isError ?? false },
      sessionId: options.sessionId,
      turnId: options.turnId,
    };
    try {
      if (options.eventBus.emitAsync) await options.eventBus.emitAsync("tool.execute.after", afterPayload);
      else options.eventBus.emit("tool.execute.after", afterPayload);
    } catch {}
    options.eventBus.emit("event", { event: "tool.execute.after", payload: afterPayload });
    if (
      !result.isError &&
      (resolved.name === "write" || resolved.name === "edit") &&
      typeof call.input.path === "string"
    ) {
      try {
        options.eventBus.emit("file.edited", { path: call.input.path });
        options.eventBus.emit("event", { event: "file.edited", payload: { path: call.input.path } });
      } catch {}
    }
  }

  return { content: result.content, isError: result.isError ?? false, images: result.images };
}

const SIMPLE_TYPES: Record<string, (value: unknown) => boolean> = {
  string: (v) => typeof v === "string",
  number: (v) => typeof v === "number" && Number.isFinite(v),
  integer: (v) => typeof v === "number" && Number.isInteger(v),
  boolean: (v) => typeof v === "boolean",
  object: (v) => typeof v === "object" && v !== null && !Array.isArray(v),
  array: (v) => Array.isArray(v),
  null: (v) => v === null,
};

/**
 * Minimal JSON-Schema validation over the subset tool `inputSchema`s use
 * (object root, `properties` with `type`/`enum`, `required`, shallow `items`).
 * Deliberately permissive: unknown keywords and untyped properties pass — the
 * goal is catching `{path: 123}`-shaped garbage with an actionable message,
 * not reimplementing a spec-complete validator.
 */
export function validateToolInput(schema: Record<string, unknown>, input: unknown): string | undefined {
  if (!schema || typeof schema !== "object") return undefined;
  if (schema.type === "object" && (typeof input !== "object" || input === null || Array.isArray(input))) {
    return `invalid input: expected an object, got ${describeType(input)}`;
  }
  if (typeof input !== "object" || input === null) return undefined;

  const properties = schema.properties;
  const required = schema.required;
  if (Array.isArray(required)) {
    for (const name of required) {
      if (typeof name === "string" && !(name in input)) {
        return `invalid input: missing required property "${name}"`;
      }
    }
  }
  if (!properties || typeof properties !== "object") return undefined;
  const record = input as Record<string, unknown>;

  for (const [name, rawSpec] of Object.entries(properties as Record<string, unknown>)) {
    if (!(name in record)) continue;
    const value = record[name];
    if (!(rawSpec && typeof rawSpec === "object")) continue;
    const propSchema = rawSpec as Record<string, unknown>;

    if (typeof propSchema.type === "string") {
      const check = SIMPLE_TYPES[propSchema.type];
      if (check && !check(value)) {
        return `invalid input: "${name}" must be ${propSchema.type}, got ${describeType(value)}`;
      }
    }
    if (Array.isArray(propSchema.enum) && !propSchema.enum.some((option) => option === value)) {
      return `invalid input: "${name}" must be one of ${JSON.stringify(propSchema.enum)}`;
    }
    if (propSchema.type === "array" && Array.isArray(value)) {
      const itemSpec = propSchema.items;
      if (
        itemSpec &&
        typeof itemSpec === "object" &&
        typeof (itemSpec as Record<string, unknown>).type === "string"
      ) {
        const itemCheck = SIMPLE_TYPES[(itemSpec as Record<string, unknown>).type as string];
        if (itemCheck) {
          const bad = value.findIndex((item) => !itemCheck(item));
          if (bad !== -1) {
            return `invalid input: "${name}[${bad}]" must be ${(itemSpec as Record<string, unknown>).type}, got ${describeType(value[bad])}`;
          }
        }
      }
    }
  }
  return undefined;
}

function describeType(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

interface CollectedTurn {
  content: ContentBlock[];
  stopReason: StopReason;
  usage: Usage;
  /** Tool-call ids whose streamed arguments never parsed, mapped to the per-call error message. */
  malformedCalls: Map<string, string>;
}

async function collectTurn(
  adapter: ProviderAdapter,
  http: HttpClient,
  request: Parameters<ProviderAdapter["stream"]>[0],
  onEvent: ((event: LoopEvent) => void) | undefined,
): Promise<CollectedTurn> {
  const content: ContentBlock[] = [];
  const jsonByToolId = new Map<string, string>();
  const nameByToolId = new Map<string, string>();
  const malformedCalls = new Map<string, string>();
  let usage: Usage = { inputTokens: 0, outputTokens: 0 };
  let stopReason: StopReason = "end_turn";

  for await (const event of withMidStreamRecovery(adapter.stream(request, http))) {
    switch (event.type) {
      case "text_delta":
        appendText(content, "text", event.text);
        onEvent?.({ type: "text_delta", text: event.text });
        break;
      case "thinking_delta":
        appendText(content, "thinking", event.text);
        onEvent?.({ type: "thinking_delta", text: event.text });
        break;
      case "thinking_signature": {
        const last = content[content.length - 1];
        if (last?.type === "thinking" && last.signature === undefined) {
          last.signature = event.signature;
        } else if (last?.type !== "thinking") {
          content.push({ type: "thinking", text: "", signature: event.signature });
        } else {
          // Trailing block already carries a signature: a second signature
          // without intervening thinking text starts its own placeholder so
          // no provider-issued signature is ever dropped.
          content.push({ type: "thinking", text: "", signature: event.signature });
        }
        break;
      }
      case "redacted_thinking":
        content.push({ type: "redacted_thinking", data: event.data });
        break;
      case "tool_call_start":
        nameByToolId.set(event.id, event.name);
        jsonByToolId.set(event.id, "");
        break;
      case "tool_call_delta":
        jsonByToolId.set(event.id, (jsonByToolId.get(event.id) ?? "") + event.inputJsonDelta);
        break;
      case "tool_call_end": {
        const raw = jsonByToolId.get(event.id) ?? "";
        let input: Record<string, unknown> = {};
        if (raw.trim()) {
          try {
            input = JSON.parse(raw) as Record<string, unknown>;
          } catch {
            // One malformed delta must not kill the whole turn: attempt a
            // repair pass, and if the arguments are beyond repair, record a
            // per-call error (runTools turns it into an error tool_result)
            // instead of throwing away the entire turn.
            const repaired = repairToolJson(raw);
            if (repaired) {
              input = repaired;
            } else {
              malformedCalls.set(
                event.id,
                `tool arguments were not valid JSON (even after repair): ${raw.slice(0, 500)}`,
              );
            }
          }
        }
        // The tool_start event fires once the streamed arguments are parsed
        // (not at tool_call_start): the TUI's renderCall needs the input, and
        // nothing else can run between here and the provider round-trip.
        content.push({ type: "tool_call", id: event.id, name: nameByToolId.get(event.id) ?? "", input });
        onEvent?.({ type: "tool_start", id: event.id, name: nameByToolId.get(event.id) ?? "", input });
        break;
      }
      case "message_stop":
        usage = event.usage;
        stopReason = event.stopReason;
        break;
    }
  }

  return { content, stopReason, usage, malformedCalls };
}

/**
 * Best-effort repair for the near-miss JSON providers stream as tool
 * arguments: trailing commas, unquoted keys, and braces/brackets the stream
 * cut off. Only ever called after JSON.parse already failed, so it cannot
 * corrupt well-formed input. Returns undefined when nothing salvageable
 * remains and the caller should fall back to a per-call error.
 */
function repairToolJson(raw: string): Record<string, unknown> | undefined {
  let repaired = raw
    .replace(/,\s*([}\]])/g, "$1") // trailing commas: {"a":1,} -> {"a":1}
    .replace(/([{,]\s*)([A-Za-z_$][\w$]*)(\s*:)/g, '$1"$2"$3'); // unquoted keys: {a:1} -> {"a":1}
  // Close braces/brackets the stream truncated (string literals blanked first
  // so braces inside strings don't skew the count).
  const stripped = repaired.replace(/"(?:[^"\\]|\\.)*"/g, '""');
  let braces = 0;
  let brackets = 0;
  for (const ch of stripped) {
    if (ch === "{") braces++;
    else if (ch === "}") braces--;
    else if (ch === "[") brackets++;
    else if (ch === "]") brackets--;
  }
  if (braces > 0) repaired += "}".repeat(braces);
  if (brackets > 0) repaired += "]".repeat(brackets);
  try {
    const parsed: unknown = JSON.parse(repaired);
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function appendText(content: ContentBlock[], type: "text" | "thinking", delta: string): void {
  const last = content[content.length - 1];
  if (last && last.type === "thinking" && type === "thinking") {
    // Don't merge into a thinking block that's already signature-closed:
    // a second thinking block with its own signature must remain separate.
    if (last.signature !== undefined) {
      content.push({ type: "thinking", text: delta });
      return;
    }
    last.text += delta;
    return;
  }
  if (last && last.type === "text" && type === "text") {
    last.text += delta;
    return;
  }
  content.push(type === "text" ? { type: "text", text: delta } : { type: "thinking", text: delta });
}

function addUsage(a: Usage, b: Usage): Usage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cachedInputTokens: (a.cachedInputTokens ?? 0) + (b.cachedInputTokens ?? 0),
  };
}

function totalTokens(usage: Usage): number {
  return usage.inputTokens + usage.outputTokens;
}

function costOf(usage: Usage, price?: PricePerMTok): number {
  if (!price) return 0;
  return (usage.inputTokens / 1_000_000) * price.input + (usage.outputTokens / 1_000_000) * price.output;
}

function exceedsBudget(usage: Usage, spentCostUsd: number, budget?: Budget): boolean {
  if (!budget) return false;
  if (budget.maxTokens !== undefined && totalTokens(usage) >= budget.maxTokens) return true;
  if (budget.maxCostUsd !== undefined && spentCostUsd >= budget.maxCostUsd) return true;
  return false;
}
