import type {
  ApprovalRequest,
  CallerIdentity,
  Capabilities,
  RequestApproval,
  RiskTier,
  ToolPolicy,
} from "@agency/guard";
import { isCommandPatternTool, isPathPatternTool, PermissionsGate, requireTool } from "@agency/guard";
import type { HttpClient } from "@agency/net";
import {
  type CacheSegment,
  type ProviderAdapter,
  type Scheduler,
  selectModel,
  type ThinkingLevel,
  type ToolDefinition,
  tokenizerFor,
  type Usage,
  withCheapFallback,
  withMidStreamRecovery,
} from "@agency/providers";
import {
  AgencyError,
  type ContentBlock,
  ErrorCode,
  type ImageBlock,
  type Message,
  type StopReason,
} from "@agency/schema";
import type { AutoReviewer } from "./auto-review.ts";
import { CODE_TOOL } from "./codemode.ts";
import { permissionsFromRules } from "./config/claude-permissions.ts";
import { type AgencyEvents, HookBlock, HookStop } from "./events.ts";
import { pruneStaleResults } from "./prune.ts";
import {
  compactMessages,
  countMessageTokens,
  isContextOverflowError,
  triggerTokens,
  withOverhead,
} from "./sessions/compaction.ts";
import type { MessageOrigin } from "./sessions/entry.ts";
import { modelSummarizer } from "./sessions/summarize.ts";
import type { TraceRecorder } from "./trace/recorder.ts";
import { truncateToolResults } from "./truncate.ts";

export interface ToolSpec<Input = Record<string, unknown>> extends ToolDefinition {
  handler(
    input: Input & Record<string, unknown>,
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
      /** Variables that plugins add to the environment of a shell command (the `shell.env` event). */
      env?: Record<string, string>;
      /** Pre-approves tools for the rest of the turn, as rules of Claude Code: the `allowed-tools` of a skill. */
      grantTools?: (rules: string[]) => void;
      /** Runs another tool of this turn through the same checks as a call of the model. */
      callTool?: (
        name: string,
        input: Record<string, unknown>,
      ) => Promise<{ content: string; isError: boolean; images?: ImageBlock[] }>;
    },
  ): Promise<{ content: string; isError?: boolean; images?: ImageBlock[] }>;
  renderCall?(input: Input & Record<string, unknown>): string;
  renderResult?(result: {
    content: string;
    isError?: boolean;
    images?: ImageBlock[];
    input?: Record<string, unknown>;
  }): string;
  /** How risky this tool is by nature; the permission gate and the trust
   *  gate both consume it (`safe` runs freely, the rest asks and needs a
   *  trusted workspace). Unclassified tools are treated as ungated. */
  riskTier?: RiskTier;
  /** Asked before each request: a hidden tool is not in the tool list, and a call of it is refused. */
  hidden?: () => boolean;
}

/** Erased tool type for registries holding mixed-input tools. */
export type AnyToolSpec = ToolSpec<Record<string, unknown>>;

/** The model is told one time when this number of tool steps is left, and when this share of the cost limit is spent. */
const LOW_STEPS = 5;
const COST_NOTE_SHARE = 0.8;

export interface Budget {
  maxTokens?: number;
  maxCostUsd?: number;
}

export interface PricePerMTok {
  input: number;
  output: number;
  cachedInput?: number;
  cacheWrite?: number;
}

/** One model request: request start to its first output (text, thinking or a tool call), then that output to the stream end. */
export interface RequestTiming {
  ttftMs: number;
  streamMs: number;
}

export type LoopEvent =
  | { type: "text_delta"; text: string }
  | { type: "thinking_delta"; text: string }
  | { type: "tool_start"; id: string; name: string; input?: Record<string, unknown> }
  | { type: "tool_result"; id: string; content: string; isError: boolean; images?: ImageBlock[] }
  | { type: "tool_progress"; id: string; name: string; message: string }
  | { type: "turn_complete"; stopReason: StopReason; usage: Usage; timing?: RequestTiming }
  | { type: "budget_exceeded"; spentTokens: number; spentCostUsd: number }
  | { type: "iteration_limit"; iterations: number }
  | { type: "error"; code: string; message: string }
  | { type: "retry"; attempt: number; message: string; next?: number }
  | { type: "model_route"; model: string; routed: "cheap" | "primary"; tag: string };

export interface RunTurnOptions {
  identity: CallerIdentity;
  capabilities: Capabilities;
  systemPrompt: string;
  systemSegments?: CacheSegment[];
  tools: ToolSpec[];
  model: string;
  apiKey: string;
  thinkingLevel?: ThinkingLevel;
  session: Message[];
  budget?: Budget;
  pricePerMTok?: PricePerMTok;
  maxTokensPerRequest?: number;
  drainMailbox?: () => Message[];
  /** The user's messages sent during the turn, drained once more at its end: team mailboxes stay out of it. */
  drainSteering?: () => Message[];
  /** Team control (B3): detects identical tool+input 3x consecutively and
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
  /** Auto mode: answers an ask of a default rule before the user does; an ask rule of the config goes to the user. */
  reviewApproval?: AutoReviewer;
  /**
   * The permissions gate consulted before each tool handler runs: `deny`
   * produces a per-call error without invoking the handler, `ask` routes
   * through `requestApproval`. Absent = no permission enforcement.
   */
  toolPolicy?: ToolPolicy;
  /** Caps tool-calling round-trips even when nothing else stops the run:
   *  a runaway model that keeps calling tools shouldn't spin forever. */
  maxToolIterations?: number;
  /** What the user wants the summary of a compaction to keep. */
  compactionInstructions?: string;
  /** Longest silence allowed on a provider stream before the request is cut. Default 5 minutes. */
  streamIdleMs?: number;
  signal?: AbortSignal;
  onEvent?: (event: LoopEvent) => void;
  /** Applied to the text of each tool result before the model, the hooks and the session get it. */
  redactToolResult?: (text: string, tool?: string) => string;
  eventBus?: {
    emit: (event: string, payload: unknown) => void;
    emitAsync?: (event: string, payload: unknown) => Promise<void>;
    emitCollect?: (event: string, payload: unknown) => Promise<{ errors: unknown[] }>;
  };
  /** Overflow hook (U8): runs once per request on context overflow, then that
   *  request is retried exactly once. A returned message list replaces
   *  the history for the retry (reactive compact-and-retry). Absent means
   *  the loop folds its own transcript in memory. */
  onContextOverflow?: (overheadTokens?: number) => Promise<Message[] | undefined>;
  /** The model's window in tokens: sizes the in-memory fold. Default 200k. */
  contextWindow?: number;
  /** `compactionLimit` of the config: the history is compacted at this size also when the window is larger. */
  compactionLimit?: number;
  /** `keepToolResults` of the config: old results of re-runnable tools stay whole in each request. */
  keepToolResults?: boolean;
  /** Rules of Claude Code that the turn starts with pre-approved: the `allowed-tools` of a skill that `/name` ran. */
  grantedTools?: string[];
  /** The model takes image input: images that a tool returned go to it. Absent means no. */
  vision?: boolean;
  /** The reasoning levels the model lists (ModelInfo.efforts): a listed level goes to the API unchanged. */
  efforts?: readonly ThinkingLevel[];
  /** Runs for each message the turn appends, in order and before the next step: a session owner persists here.
   *  `origin` marks a user-role message that did not come from the prompt (see MessageOrigin). */
  onMessage?: (message: Message, origin?: MessageOrigin) => void | Promise<void>;
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

/** A guard against a model that never stops, not a budget for the work: a cost limit is the budget. */
export const DEFAULT_MAX_TOOL_ITERATIONS = 100;

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
  /** Tokens of the last request, prompt and reply: the context the next request starts from. `usage` sums all. */
  contextTokens?: number;
  /** Why the turn did not finish: a salvaged stream (stop reason `error`) or the step limit (stop reason `tool_use`).
   *  A turn that fails before any content throws instead. */
  error?: TurnError;
}

export type TurnError = { code: string; message: string };

/**
 * The R4 seam: no globals, every dependency passed in, so a second concurrent
 * loop (a future teammate agent) is additive rather than a rewrite. One call
 * drives a full turn, including any tool-calling round-trips it takes to
 * reach a non-tool_use stop reason, a budget breach, or the iteration cap.
 */
/** The tools pre-approved in a turn; a skill that the model loads adds its rules. */
const turnGrants = new WeakMap<RunTurnOptions, string[]>();

/**
 * True when a granted rule allows the call. As in Claude Code, a grant answers only a prompt of no rule: a deny rule
 * or an ask pattern of the config still holds.
 */
function granted(
  rules: string[],
  request: { tool: string; command?: string; path?: string },
  cwd?: string,
): boolean {
  if (rules.length === 0) return false;
  const { permissions } = permissionsFromRules({ allow: rules });
  const gate = new PermissionsGate({
    permissions,
    workspaceRoot: cwd ?? process.cwd(),
    absentToolsDenied: true,
  });
  return gate.decisionFor({ ...request, riskTier: "dangerous" }) === "allow";
}

export async function runTurn(
  adapter: ProviderAdapter,
  scheduler: Scheduler,
  http: HttpClient,
  options: RunTurnOptions,
): Promise<RunTurnResult> {
  turnGrants.set(options, [...(options.grantedTools ?? [])]);
  const messages = [...options.session];
  // The reviewer of auto mode reads the transcript of this turn as it grows.
  const review = options.reviewApproval;
  const toolOptions: RunTurnOptions =
    review === undefined ? options : { ...options, reviewApproval: (request) => review(request, messages) };
  const append = async (message: Message, origin?: MessageOrigin): Promise<void> => {
    messages.push(message);
    await options.onMessage?.(message, origin);
  };
  const maxToolIterations = options.maxToolIterations ?? DEFAULT_MAX_TOOL_ITERATIONS;
  const toolDefs = (): ToolDefinition[] =>
    options.tools
      .filter((t) => !t.hidden?.())
      .map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }));

  let cumulativeUsage: Usage = { inputTokens: 0, outputTokens: 0 };
  let spentCostUsd = 0;
  let stopReason: StopReason = "end_turn";
  let salvageError: TurnError | undefined;
  let spoke = false;
  let outputContinuations = 0;
  let stopBlocked = false;
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

  // Doom-loop detection is an team control (B3): opt-in per turn, enabled for
  // dispatched peers. The solo team keeps its existing semantics: a runaway
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
              ...(options.systemSegments !== undefined ? { systemSegments: options.systemSegments } : {}),
              messages: options.keepToolResults ? messages : pruneStaleResults(messages),
              tools: toolDefs(),
              maxTokens: options.maxTokensPerRequest ?? 8192,
              thinkingLevel: options.thinkingLevel,
              ...(options.vision === undefined ? {} : { vision: options.vision }),
              ...(options.efforts === undefined ? {} : { efforts: options.efforts }),
              signal: options.signal,
            },
            options.onEvent,
            options.streamIdleMs ?? adapter.streamIdleMs,
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
  const compactionThreshold = {
    // A model that is not in the catalog has a window of 0 or none: both mean not known.
    contextWindow: options.contextWindow || 200_000,
    ...(options.compactionLimit === undefined ? {} : { limitTokens: options.compactionLimit }),
  };
  // The size of the last request as the provider counted it. Zero after a compaction: the next request gives the new size.
  let requestTokens = 0;
  let proactiveFolds = true;
  let costNoted = false;
  const foldInMemory = (overheadTokens = 0): Promise<Message[] | undefined> =>
    compactMessages(
      messages,
      tokenizerFor(options.provider ?? ""),
      withOverhead(compactionThreshold, overheadTokens),
      modelSummarizer({
        adapter,
        http,
        model: options.model,
        apiKey: options.apiKey,
        ...(options.maxTokensPerRequest === undefined ? {} : { maxTokens: options.maxTokensPerRequest }),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
        ...(options.compactionInstructions === undefined
          ? {}
          : { instructions: options.compactionInstructions }),
      }),
    );
  for (let iteration = 0; iteration < maxToolIterations; iteration++) {
    // One fold for each request: a long turn can fill the window more than once.
    let overflowRetried = false;
    if (options.drainMailbox) {
      let injected: Message[] = [];
      try {
        injected = options.drainMailbox();
      } catch {}
      for (const message of injected) await append(message, "inbox");
    }
    // Before the provider refuses: a request near the limit costs the most, and a refused one is a lost request.
    let folded = false;
    if (proactiveFolds && requestTokens >= triggerTokens(compactionThreshold)) {
      // The request also holds the system prompt and the tool list: the history must leave room for them.
      const inHistory = await countMessageTokens(messages, tokenizerFor(options.provider ?? ""));
      const overhead = Math.max(0, requestTokens - inHistory);
      const replacement = await (options.onContextOverflow ?? foldInMemory)(overhead);
      if (replacement !== undefined) {
        messages.length = 0;
        messages.push(...replacement);
      }
      folded = true;
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
        if (overflowRetried || !isContextOverflowError(error)) throw error;
        overflowRetried = true;
        const replacement = await (options.onContextOverflow ?? foldInMemory)();
        // Nothing folded and no owner hook: a retry would send the same request.
        if (replacement === undefined && !options.onContextOverflow) throw error;
        if (replacement !== undefined) {
          messages.length = 0;
          messages.push(...replacement);
        }
        options.onEvent?.({
          type: "retry",
          attempt: 1,
          message: "context overflow: compacted, retrying once",
        });
        turn = await collectWithFallback();
      }

      if (turn.stopReason === "max_tokens" && outputContinuations < MAX_OUTPUT_CONTINUATIONS) {
        turn.content = withoutCutLine(turn.content);
      }
      // A reply with no content is not stored: strict providers reject an empty message.
      if (turn.content.length > 0) await append({ role: "assistant", content: turn.content });
      spoke = turn.content.some((block) => block.type === "text" && block.text.trim() !== "");
      cumulativeUsage = addUsage(cumulativeUsage, turn.usage);
      requestTokens = turn.usage.inputTokens + turn.usage.outputTokens;
      // A compaction that left the request at the trigger size cannot help: the next ones would each cost a summary.
      if (folded && requestTokens >= triggerTokens(compactionThreshold)) proactiveFolds = false;
      const turnCost = costOf(turn.usage, options.pricePerMTok);
      spentCostUsd += turnCost;
      const toolCalls = toolCallsOf({ role: "assistant", content: turn.content });
      // A stream the caller cut is a cancel, not a provider failure.
      const cut = turn.stopReason === "error" && options.signal?.aborted;
      stopReason = cut ? "cancelled" : turn.stopReason;
      // A tool stop reason with no call has nothing to run: the loop would ask again with an empty result.
      if (stopReason === "tool_use" && toolCalls.length === 0) stopReason = "end_turn";
      // A reply cut at the output limit can hold complete calls. They run, and a call that the cut broke gets its parse error.
      if (stopReason === "max_tokens" && toolCalls.length > 0) {
        stopReason = "tool_use";
        for (const id of turn.malformedCalls.keys()) turn.malformedCalls.set(id, CUT_CALL_NOTE);
      }
      salvageError = cut ? undefined : turn.error;
      options.onEvent?.({ type: "turn_complete", stopReason, usage: turn.usage, timing: turn.timing });
      if (tracer && modelSpanId) {
        tracer.endSpan(modelSpanId, {
          status: turn.stopReason === "error" ? "error" : "ok",
          attributes: {
            inputTokens: turn.usage.inputTokens,
            outputTokens: turn.usage.outputTokens,
            cachedInputTokens: turn.usage.cachedInputTokens,
            cacheWriteInputTokens: turn.usage.cacheWriteInputTokens,
            cost: turnCost,
          },
        });
        modelSpanId = null;
      }

      if (exceedsBudget(cumulativeUsage, spentCostUsd, options.budget)) {
        if (toolCalls.length > 0) {
          await append(
            options.signal?.aborted
              ? unrunResults(toolCalls, "cancelled")
              : {
                  role: "user",
                  content: await runTools(toolCalls, toolOptions, turn.malformedCalls, options.signal),
                },
          );
        }
        options.onEvent?.({
          type: "budget_exceeded",
          spentTokens: totalTokens(cumulativeUsage),
          spentCostUsd,
        });
        endTurnOk();
        return {
          messages,
          stopReason,
          usage: cumulativeUsage,
          budgetExceeded: true,
          ...(requestTokens > 0 ? { contextTokens: requestTokens } : {}),
        };
      }

      if (stopReason !== "tool_use" || options.signal?.aborted) {
        if (toolCalls.length > 0) {
          await append(unrunResults(toolCalls, options.signal?.aborted ? "cancelled" : stopReason));
        }
        // A reply cut at the output limit is not an end: the model goes on from the cut, a limited number of times.
        // With no text there is nothing to go on from: the limit is too small for the model's thinking.
        const cutShort = stopReason === "max_tokens" && !options.signal?.aborted && spoke;
        if (cutShort && outputContinuations < MAX_OUTPUT_CONTINUATIONS) {
          outputContinuations += 1;
          await append({ role: "user", content: [{ type: "text", text: OUTPUT_CUT_NOTE }] }, "harness");
          continue;
        }
        // A stop hook can refuse the end of the turn: its reason goes to the model. The step limit bounds this.
        const canGoOn =
          stopReason === "end_turn" && !options.signal?.aborted && iteration + 1 < maxToolIterations;
        if (canGoOn && options.eventBus?.emitCollect) {
          const { errors } = await options.eventBus.emitCollect("turn.stop", {
            sessionId: options.sessionId,
            turnId: options.turnId,
            taskDepth: options.taskDepth ?? 0,
            stopHookActive: stopBlocked,
            lastAssistantMessage: turn.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join(""),
          });
          const reasons = errors.filter((e): e is HookBlock => e instanceof HookBlock).map((e) => e.message);
          if (reasons.length > 0) {
            stopBlocked = true;
            await append(
              { role: "user", content: [{ type: "text", text: reasons.join("\n\n") }] },
              "harness",
            );
            continue;
          }
        }
        // A message sent while the model gave its last answer would wait for the next turn: answer it now.
        if (canGoOn && options.drainSteering) {
          let late: Message[] = [];
          try {
            late = options.drainSteering();
          } catch {}
          if (late.length > 0) {
            for (const message of late) await append(message, "inbox");
            continue;
          }
        }
        break;
      }

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
      const results = await runTools(toolCalls, toolOptions, turn.malformedCalls, options.signal);
      if (options.eventBus?.emitCollect) {
        const { errors } = await options.eventBus.emitCollect("tool.batch.after", {
          calls: toolCalls.map((tc, i) => {
            const r = results[i];
            const result =
              r?.type === "tool_result"
                ? { content: r.content, isError: r.isError }
                : { content: "", isError: false };
            return { id: tc.id, tool: tc.name, input: tc.input, result };
          }),
          sessionId: options.sessionId,
          turnId: options.turnId,
        });
        const stop = errors.find((e): e is HookStop => e instanceof HookStop);
        if (stop) {
          await append({ role: "user", content: results });
          salvageError = { code: "hook_stop", message: stop.message };
          stopReason = "end_turn";
          break;
        }
        // The text of the hooks goes once into the last result, as the text of a PostToolUse hook into its own.
        const added = errors.filter((e): e is HookBlock => e instanceof HookBlock).map((e) => e.message);
        const lastResult = results.at(-1);
        if (added.length > 0 && lastResult?.type === "tool_result") {
          results[results.length - 1] = {
            ...lastResult,
            content: [lastResult.content, ...added].join("\n\n"),
          };
        }
      }
      // A model does not know the limits of its turn. The line goes into a result: the history stays append-only.
      const notes: string[] = [];
      const stepsLeft = maxToolIterations - iteration - 1;
      if (stepsLeft === LOW_STEPS && maxToolIterations >= 2 * LOW_STEPS) {
        notes.push(
          `${LOW_STEPS} tool steps are left in this turn. Finish the task, or say what is not done.`,
        );
      }
      const costLimit = options.budget?.maxCostUsd;
      if (!costNoted && costLimit !== undefined && spentCostUsd >= costLimit * COST_NOTE_SHARE) {
        costNoted = true;
        notes.push(
          `${Math.round((spentCostUsd / costLimit) * 100)} percent of the cost limit of this turn is spent. Finish the task, or say what is not done.`,
        );
      }
      const last = results.at(-1);
      if (notes.length > 0 && last?.type === "tool_result") {
        results[results.length - 1] = {
          ...last,
          content: `${last.content}\n\n[harness: ${notes.join(" ")}]`,
        };
      }
      await append({ role: "user", content: results });
    } catch (error) {
      if (tracer && modelSpanId) {
        try {
          tracer.endSpan(modelSpanId, { status: "error" });
        } catch {}
      }
      const calls = messages.at(-1)?.role === "assistant" ? toolCallsOf(messages.at(-1)) : [];
      if (options.signal?.aborted) {
        if (calls.length > 0) await append(unrunResults(calls, "cancelled"));
        stopReason = "cancelled";
        options.onEvent?.({
          type: "turn_complete",
          stopReason,
          usage: { inputTokens: 0, outputTokens: 0 },
        });
        break;
      }
      endTurnError();
      emitErrorEvent(error, options.onEvent);
      if (calls.length > 0) await append(unrunResults(calls, "error"));
      throw error;
    }
  }

  // The stop reason stays tool_use; the error tells a caller with no event listener that the work is not finished.
  let turnError = salvageError;
  if (stopReason === "tool_use" && !options.signal?.aborted) {
    options.onEvent?.({ type: "iteration_limit", iterations: maxToolIterations });
    turnError = {
      code: "iteration_limit",
      message: `stopped after ${maxToolIterations} tool steps: the task is not finished`,
    };
  } else if (!turnError && stopReason === "max_tokens") {
    turnError = {
      code: "max_tokens",
      message: spoke
        ? `the reply was cut at the output limit (continued ${outputContinuations} times): the answer is not complete`
        : `the output limit of ${options.maxTokensPerRequest ?? 8192} tokens was used before any answer text, most likely by the model's thinking: set a higher maxOutputTokens for this model in the config`,
    };
  } else if (!turnError && !spoke && stopReason !== "cancelled") {
    // No text is no answer: a headless caller must not read it as success.
    turnError = {
      code: "empty_response",
      message: `the model returned no text (stop reason: ${stopReason})`,
    };
  } else if (!turnError && stopReason === "error") {
    turnError = {
      code: "provider_stop",
      message: "the provider ended the reply with an error: the answer is not complete",
    };
  }

  endTurnOk();
  return {
    messages,
    stopReason,
    usage: cumulativeUsage,
    budgetExceeded: false,
    ...(requestTokens > 0 ? { contextTokens: requestTokens } : {}),
    ...(turnError ? { error: turnError } : {}),
  };
}

function toolCallsOf(message: Message | undefined): Array<Extract<ContentBlock, { type: "tool_call" }>> {
  return (message?.content ?? []).filter(
    (b): b is Extract<ContentBlock, { type: "tool_call" }> => b.type === "tool_call",
  );
}

/** A provider that sends nothing for this long has stalled: without a limit the turn waits until a cancel. */
const STREAM_IDLE_MS = 5 * 60_000;

/** How many times in a row the model is asked to go on after a reply that was cut at the output limit. */
const MAX_OUTPUT_CONTINUATIONS = 3;
export const OUTPUT_CUT_NOTE =
  "Your reply was cut at the output limit. Continue from the exact point where it stopped. Do not repeat text.";
const CUT_CALL_NOTE =
  "not run: the output limit cut this call before its arguments were complete. Send it again with shorter arguments, for example write a long file in smaller parts.";

/** Measured: a model writes the cut line again from its start, so the half line was in the output twice. */
function withoutCutLine(content: ContentBlock[]): ContentBlock[] {
  const last = content.at(-1);
  if (last?.type !== "text") return content;
  const kept = last.text.slice(0, Math.max(0, last.text.lastIndexOf("\n")));
  return kept.trim() === "" ? content : [...content.slice(0, -1), { ...last, text: kept }];
}

/** Every provider rejects a tool call that has no result, so a turn that stops early answers its calls. */
function unrunResults(calls: ReadonlyArray<{ id: string }>, why: string): Message {
  return {
    role: "user",
    content: calls.map((call) => ({
      type: "tool_result",
      toolCallId: call.id,
      content: `not run: the turn ended (${why}) before this call started`,
      isError: true,
    })),
  };
}

/** AgencyError-like errors carry a string `code`; anything else is reported as internal. */
function describeError(error: unknown): TurnError {
  if (!(error instanceof Error)) return { code: "internal", message: String(error) };
  const code = "code" in error && typeof error.code === "string" ? error.code : "internal";
  return { code, message: error.message };
}

function emitErrorEvent(error: unknown, onEvent?: (event: LoopEvent) => void): void {
  onEvent?.({ type: "error", ...describeError(error) });
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
      // A strict provider (Cohere) rejects an empty result, and a model reads an empty one as a failure.
      content: result.content || "(no output)",
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

const MUTATING_TOOLS: ReadonlySet<string> = new Set(["write", "edit", "notebook_edit", "bash"]);

async function executeOne(
  spec: ToolSpec | undefined,
  modelCall: Extract<ContentBlock, { type: "tool_call" }>,
  options: RunTurnOptions,
  signal: AbortSignal | undefined,
  inner = false,
): Promise<{ content: string; isError: boolean; images?: ImageBlock[] }> {
  let call = modelCall;
  const resolved = spec ?? resolveToolSpec(options.tools, call.name);
  if (!resolved) {
    const available = options.tools.map((t) => t.name).join(", ");
    return { content: `no such tool: "${call.name}" (available: ${available})`, isError: true };
  }
  // A hidden tool is out of the tool list of the request. A call from another tool (call_tool, code) can reach it.
  if (!inner && resolved.hidden?.()) {
    const hint = `the tool "${resolved.name}" is not loaded: find it with tool_search, then call it with call_tool`;
    return { content: hint, isError: true };
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

  // As in Claude Code, PreToolUse comes before the permission check: the rules judge the input that a hook gave.
  const before: AgencyEvents["tool.execute.before"] = {
    tool: resolved.name,
    input: call.input,
    sessionId: options.sessionId,
    turnId: options.turnId,
  };
  if (options.eventBus) {
    try {
      if (options.eventBus.emitCollect) {
        const { errors } = await options.eventBus.emitCollect("tool.execute.before", before);
        if (errors.length > 0) {
          const first = errors[0];
          return { content: first instanceof Error ? first.message : String(first), isError: true };
        }
      } else if (options.eventBus.emitAsync) {
        await options.eventBus.emitAsync("tool.execute.before", before);
      } else {
        options.eventBus.emit("tool.execute.before", before);
      }
    } catch {}
    options.eventBus.emit("event", { event: "tool.execute.before", payload: before });
    if (before.input !== call.input) {
      call = { ...call, input: before.input };
      const error = validateToolInput(resolved.inputSchema, call.input);
      if (error)
        return { content: `the input that a PreToolUse hook gave is not valid: ${error}`, isError: true };
    }
  }

  let shellEnv: Record<string, string> | undefined;
  if (options.eventBus && resolved.name === "bash") {
    try {
      const envPayload = { env: {} as Record<string, string>, sessionId: options.sessionId };
      // A listener can be async (an OpenCode plugin): its variables count only once it has run.
      if (options.eventBus.emitAsync) await options.eventBus.emitAsync("shell.env", envPayload);
      else options.eventBus.emit("shell.env", envPayload);
      options.eventBus.emit("event", { event: "shell.env", payload: envPayload });
      if (Object.keys(envPayload.env).length > 0) shellEnv = envPayload.env;
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
      // The user who is asked must see the script, not only the name of the tool.
      const title =
        resolved.name === CODE_TOOL && typeof call.input.code === "string" ? { title: call.input.code } : {};
      // In auto mode the reviewer answers first. A PermissionRequest hook can answer an ask before the user gets it.
      const askUser = options.requestApproval;
      const review = options.reviewApproval;
      let blocked: string | undefined;
      // A PreToolUse `allow` answers the prompt of a default ask only: an ask rule of the config still asks.
      const hookAllows = before.decision === "allow";
      const grants = turnGrants.get(options) ?? [];
      const ask: typeof askUser =
        askUser === undefined && review === undefined && !hookAllows && grants.length === 0
          ? undefined
          : async (request) => {
              // The ask of no rule: a tool with no entry, or a call that no pattern of its map names.
              const noRule =
                request.source?.startsWith("default:") || request.source?.endsWith(":unmatched-map-ask");
              if (hookAllows && noRule) return "once";
              if (noRule && granted(grants, request, options.cwd)) return "once";
              if (askUser === undefined && review === undefined) return "reject";
              if (review !== undefined && request.source?.startsWith("default:")) {
                const verdict = await review(request);
                if (verdict?.allow === true) return "once";
                if (verdict !== undefined) {
                  blocked = verdict.reason ?? "no reason given";
                  return "reject";
                }
              }
              if (askUser === undefined) return "reject";
              if (bus?.emitCollect === undefined) return askUser(request);
              const asked: { decision?: "allow" | "deny" } & Record<string, unknown> = {
                sessionId: options.sessionId,
                tool: request.tool,
                command: request.command,
                path: request.path,
              };
              await bus.emitCollect("permission.request", asked);
              if (asked.decision === "allow") return "once";
              if (asked.decision === "deny") return "reject";
              return askUser(request);
            };
      const policyRequest = { tool: resolved.name, riskTier: resolved.riskTier, ...subject, ...title };
      let verdict = await options.toolPolicy.check(policyRequest, ask);
      // A PreToolUse `ask` goes to the user even where a rule or the mode allows; the reviewer cannot answer it.
      if (verdict === "allow" && before.decision === "ask") {
        const answer = await askUser?.({
          tool: resolved.name,
          title: subject.command ?? subject.path ?? resolved.name,
          ...subject,
          riskTier: resolved.riskTier,
          source: "hook:PreToolUse",
        });
        if (answer === undefined || answer === "reject") verdict = "deny";
      }
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
      if (verdict === "deny" && blocked !== undefined) {
        const denied = {
          sessionId: options.sessionId,
          tool: resolved.name,
          input: call.input,
          toolUseId: call.id,
          reason: blocked,
          retry: false,
        };
        await bus?.emitCollect?.("permission.denied", denied);
        const next = denied.retry
          ? "A PermissionDenied hook says that you may retry this call."
          : "Do not try to get the same result in another way. Continue without it, or tell the user that the task needs it.";
        return {
          content: `permission denied: the auto-mode reviewer blocked this ${resolved.name} call: ${blocked}. ${next}`,
          isError: true,
        };
      }
      if (verdict === "deny") {
        // A rule on a command or a path refuses this call only: a model told the tool is refused gave up on it.
        const target = subject.command ?? subject.path;
        return {
          // Measured: with the bare first sentence a weaker model sent the same refused call 15 times on average.
          content:
            options.toolPolicy.denyReason?.(policyRequest) ??
            (target === undefined
              ? `permission denied: ${resolved.name} is not permitted by the current permissions policy. Do not call it again: the answer will be the same. Continue without it, or tell the user that the task needs this permission.`
              : `permission denied: ${resolved.name} with ${JSON.stringify(target)} is not permitted by the current permissions policy. Do not send this call again: the answer will be the same. A ${resolved.name} call with another ${subject.command === undefined ? "path" : "command"} can be permitted. Continue without this one, or tell the user that the task needs this permission.`),
          isError: true,
        };
      }
    } catch (error) {
      return { content: error instanceof Error ? error.message : String(error), isError: true };
    }
  }

  const toolSignal = signal ?? NEVER_ABORTED;
  const onEvent = options.onEvent;
  let innerCalls = 0;
  const toolCtx = {
    callTool: (name: string, input: Record<string, unknown>) => {
      innerCalls += 1;
      const inner = { type: "tool_call" as const, id: `${call.id}.${innerCalls}`, name, input };
      return executeOne(undefined, inner, options, signal, true);
    },
    signal: toolSignal,
    turnId: options.turnId,
    cwd: options.cwd,
    sessionId: options.sessionId,
    agentHandle: options.identity.type === "agent" ? options.identity.name : undefined,
    toolCallId: call.id,
    requestApproval: options.requestApproval,
    taskDepth: options.taskDepth,
    env: shellEnv,
    grantTools: (rules: string[]) => {
      const grants = turnGrants.get(options);
      if (grants === undefined) turnGrants.set(options, [...rules]);
      else grants.push(...rules);
    },
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
  if (options.redactToolResult)
    result = { ...result, content: options.redactToolResult(result.content, resolved.name) };

  if (options.eventBus) {
    const afterPayload: AgencyEvents["tool.execute.after"] = {
      tool: resolved.name,
      input: call.input,
      result: { content: result.content, isError: result.isError ?? false },
      sessionId: options.sessionId,
      turnId: options.turnId,
    };
    try {
      if (options.eventBus.emitCollect) {
        const { errors } = await options.eventBus.emitCollect("tool.execute.after", afterPayload);
        if (afterPayload.output !== undefined) result = { ...result, content: afterPayload.output };
        const notes = errors.filter((e): e is HookBlock => e instanceof HookBlock).map((e) => e.message);
        if (notes.length > 0) result = { ...result, content: [result.content, ...notes].join("\n\n") };
      } else if (options.eventBus.emitAsync) {
        await options.eventBus.emitAsync("tool.execute.after", afterPayload);
        if (afterPayload.output !== undefined) result = { ...result, content: afterPayload.output };
      } else options.eventBus.emit("tool.execute.after", afterPayload);
    } catch {}
    options.eventBus.emit("event", { event: "tool.execute.after", payload: afterPayload });
    if (before.context !== undefined)
      result = { ...result, content: `${result.content}\n\n${before.context}` };
    if (MUTATING_TOOLS.has(resolved.name)) {
      const target =
        typeof call.input.path === "string"
          ? call.input.path
          : typeof call.input.command === "string"
            ? call.input.command
            : undefined;
      const auditPayload = {
        tool: resolved.name,
        ...(target !== undefined ? { target } : {}),
        isError: result.isError ?? false,
        sessionId: options.sessionId,
        turnId: options.turnId,
        agentHandle: options.identity.type === "agent" ? options.identity.name : undefined,
      };
      try {
        options.eventBus.emit("tool.audit", auditPayload);
        options.eventBus.emit("event", { event: "tool.audit", payload: auditPayload });
      } catch {}
    }
    if (
      !result.isError &&
      (resolved.name === "write" || resolved.name === "edit" || resolved.name === "notebook_edit") &&
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
 * JSON-Schema validation over the subset that tool schemas use: `type` (also a list), `enum`, `required`,
 * `properties` and `items`, at any depth. Unknown keywords pass: the goal is a clear message for a wrong value,
 * not a complete validator.
 */
export function validateToolInput(schema: Record<string, unknown>, input: unknown): string | undefined {
  if (!schema || typeof schema !== "object") return undefined;
  if (schema.type === "object" && (typeof input !== "object" || input === null || Array.isArray(input))) {
    return `invalid input: expected an object, got ${describeType(input)}`;
  }
  if (typeof input !== "object" || input === null) return undefined;
  const fault = validateValue(schema, input, "");
  return fault === undefined ? undefined : `invalid input: ${fault}`;
}

function validateValue(schema: unknown, value: unknown, path: string): string | undefined {
  if (!schema || typeof schema !== "object") return undefined;
  const spec = schema as Record<string, unknown>;
  const types = (Array.isArray(spec.type) ? spec.type : [spec.type]).filter(
    (type): type is string => typeof type === "string" && type in SIMPLE_TYPES,
  );
  if (types.length > 0 && !types.some((type) => SIMPLE_TYPES[type]?.(value))) {
    return `"${path}" must be ${types.join(" or ")}, got ${describeType(value)}`;
  }
  if (Array.isArray(spec.enum) && !spec.enum.some((option) => option === value)) {
    return `"${path}" must be one of ${JSON.stringify(spec.enum)}`;
  }
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const fault = validateValue(spec.items, value[i], `${path}[${i}]`);
      if (fault !== undefined) return fault;
    }
    return undefined;
  }
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;
  const at = (name: string): string => (path === "" ? name : `${path}.${name}`);
  if (Array.isArray(spec.required)) {
    for (const name of spec.required) {
      if (typeof name === "string" && !(name in record)) return `missing required property "${at(name)}"`;
    }
  }
  if (!spec.properties || typeof spec.properties !== "object") return undefined;
  for (const [name, propSchema] of Object.entries(spec.properties as Record<string, unknown>)) {
    if (!(name in record)) continue;
    const fault = validateValue(propSchema, record[name], at(name));
    if (fault !== undefined) return fault;
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
  error?: TurnError;
  timing: RequestTiming;
}

async function collectTurn(
  adapter: ProviderAdapter,
  http: HttpClient,
  request: Parameters<ProviderAdapter["stream"]>[0],
  onEvent: ((event: LoopEvent) => void) | undefined,
  idleMs = STREAM_IDLE_MS,
): Promise<CollectedTurn> {
  const content: ContentBlock[] = [];
  const jsonByToolId = new Map<string, string>();
  const nameByToolId = new Map<string, string>();
  const malformedCalls = new Map<string, string>();
  let usage: Usage = { inputTokens: 0, outputTokens: 0 };
  let stopReason: StopReason = "end_turn";
  const startedAt = performance.now();
  let firstTokenAt: number | undefined;

  const idle = new AbortController();
  const stalled = () =>
    new AgencyError(ErrorCode.NETWORK, `the provider sent nothing for ${idleMs / 1000} s`, {
      source: "loop",
    });
  const watch = () => setTimeout(() => idle.abort(), idleMs);
  let idleTimer = watch();
  const signal = request.signal ? AbortSignal.any([request.signal, idle.signal]) : idle.signal;

  const salvaged: { error?: TurnError } = {};
  const stream = withMidStreamRecovery(adapter.stream({ ...request, signal }, http), (error) => {
    if (request.signal?.aborted) return;
    // A stream that dies after content is a network failure unless the adapter already typed it.
    salvaged.error =
      error instanceof AgencyError || idle.signal.aborted
        ? describeError(idle.signal.aborted ? stalled() : error)
        : { code: ErrorCode.NETWORK, message: describeError(error).message };
    onEvent?.({ type: "error", ...salvaged.error });
  });
  try {
    for await (const event of stream) {
      clearTimeout(idleTimer);
      idleTimer = watch();
      switch (event.type) {
        case "text_delta":
          firstTokenAt ??= performance.now();
          appendText(content, "text", event.text);
          onEvent?.({ type: "text_delta", text: event.text });
          break;
        case "thinking_delta":
          firstTokenAt ??= performance.now();
          appendText(content, "thinking", event.text);
          onEvent?.({ type: "thinking_delta", text: event.text });
          break;
        case "thinking_signature": {
          const last = content[content.length - 1];
          if (last?.type === "thinking" && last.signature === undefined) {
            last.signature = event.signature;
            last.family = adapter.family;
          } else if (last?.type !== "thinking") {
            content.push({ type: "thinking", text: "", signature: event.signature, family: adapter.family });
          } else {
            // Trailing block already carries a signature: a second signature
            // without intervening thinking text starts its own placeholder so
            // no provider-issued signature is ever dropped.
            content.push({ type: "thinking", text: "", signature: event.signature, family: adapter.family });
          }
          break;
        }
        case "redacted_thinking":
          content.push({ type: "redacted_thinking", data: event.data });
          break;
        case "tool_call_start":
          firstTokenAt ??= performance.now();
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
  } catch (error) {
    if (idle.signal.aborted && !request.signal?.aborted) throw stalled();
    throw error;
  } finally {
    clearTimeout(idleTimer);
  }

  // A request that gave no output at all has no first token: all of it counts as waiting.
  const endedAt = performance.now();
  const timing = {
    ttftMs: (firstTokenAt ?? endedAt) - startedAt,
    streamMs: firstTokenAt === undefined ? 0 : endedAt - firstTokenAt,
  };
  return { content, stopReason, usage, malformedCalls, timing, ...salvaged };
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

export function addUsage(a: Usage, b: Usage): Usage {
  const written = (a.cacheWriteInputTokens ?? 0) + (b.cacheWriteInputTokens ?? 0);
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cachedInputTokens: (a.cachedInputTokens ?? 0) + (b.cachedInputTokens ?? 0),
    ...(a.cacheWriteInputTokens === undefined && b.cacheWriteInputTokens === undefined
      ? {}
      : { cacheWriteInputTokens: written }),
    // ponytail: a sum of a reported and an unreported charge drops the unreported part. Price each request alone if one usage ever mixes providers.
    ...(a.costUsd === undefined && b.costUsd === undefined
      ? {}
      : { costUsd: (a.costUsd ?? 0) + (b.costUsd ?? 0) }),
  };
}

function totalTokens(usage: Usage): number {
  return usage.inputTokens + usage.outputTokens;
}

function costOf(usage: Usage, price?: PricePerMTok): number {
  if (usage.costUsd !== undefined) return usage.costUsd;
  if (!price) return 0;
  const cached = usage.cachedInputTokens ?? 0;
  const written = usage.cacheWriteInputTokens ?? 0;
  const uncached = Math.max(usage.inputTokens - cached - written, 0);
  return (
    (uncached / 1_000_000) * price.input +
    (cached / 1_000_000) * (price.cachedInput ?? price.input) +
    (written / 1_000_000) * (price.cacheWrite ?? price.input) +
    (usage.outputTokens / 1_000_000) * price.output
  );
}

function exceedsBudget(usage: Usage, spentCostUsd: number, budget?: Budget): boolean {
  if (!budget) return false;
  if (budget.maxTokens !== undefined && totalTokens(usage) >= budget.maxTokens) return true;
  if (budget.maxCostUsd !== undefined && spentCostUsd >= budget.maxCostUsd) return true;
  return false;
}
