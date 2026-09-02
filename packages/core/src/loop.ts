import type { CallerIdentity, Capabilities, RequestApproval, RiskTier, ToolPolicy } from "@agency/guard";
import { isCommandPatternTool, isPathPatternTool, requireTool } from "@agency/guard";
import type { HttpClient } from "@agency/net";
import {
  type ProviderAdapter,
  type Scheduler,
  type ThinkingLevel,
  type ToolDefinition,
  type Usage,
  withMidStreamRecovery,
} from "@agency/providers";
import type { ContentBlock, ImageBlock, Message, StopReason } from "@agency/schema";
import { truncateToolResults } from "./truncate.ts";

export type ToolHandler = (
  input: Record<string, unknown>,
  ctx: {
    signal: AbortSignal;
    turnId?: string;
    cwd?: string;
    sessionId?: string;
    toolCallId?: string;
    requestApproval?: RequestApproval;
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
  | { type: "turn_complete"; stopReason: StopReason; usage: Usage }
  | { type: "budget_exceeded"; spentTokens: number; spentCostUsd: number }
  | { type: "iteration_limit"; iterations: number }
  | { type: "error"; code: string; message: string }
  | { type: "retry"; attempt: number; message: string; next?: number };

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
}

const NEVER_ABORTED = new AbortController().signal;

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

  for (let iteration = 0; iteration < maxToolIterations; iteration++) {
    try {
      let turn: CollectedTurn;
      turn = await scheduler.schedule(
        () =>
          collectTurn(
            adapter,
            http,
            {
              model: options.model,
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
        // Per-call observer: the shared instance slot would cross-fire
        // between concurrent turns on the same scheduler.
        {
          onRetry: (attempt, message, next) => {
            options.onEvent?.({ type: "retry", attempt, message, next });
          },
        },
      );

      messages.push({ role: "assistant", content: turn.content });
      cumulativeUsage = addUsage(cumulativeUsage, turn.usage);
      spentCostUsd += costOf(turn.usage, options.pricePerMTok);
      stopReason = turn.stopReason;
      options.onEvent?.({ type: "turn_complete", stopReason, usage: turn.usage });

      const toolCalls = turn.content.filter(
        (b): b is Extract<ContentBlock, { type: "tool_call" }> => b.type === "tool_call",
      );

      if (exceedsBudget(cumulativeUsage, spentCostUsd, options.budget)) {
        // Close out pending tool calls before ending the turn: a tool_call
        // without a matching tool_result makes the persisted conversation
        // malformed, and resuming that session 400s at the provider.
        if (toolCalls.length > 0 && !options.signal?.aborted) {
          const results = await runTools(toolCalls, options, turn.malformedCalls, options.signal);
          messages.push({ role: "user", content: results });
        }
        options.onEvent?.({
          type: "budget_exceeded",
          spentTokens: totalTokens(cumulativeUsage),
          spentCostUsd,
        });
        return { messages, stopReason, usage: cumulativeUsage, budgetExceeded: true };
      }

      if (stopReason !== "tool_use" || options.signal?.aborted) break;

      const results = await runTools(toolCalls, options, turn.malformedCalls, options.signal);
      messages.push({ role: "user", content: results });
    } catch (error) {
      // Terminal for the turn: visible on the event stream (TUI/transcript), then rethrown to the caller.
      emitErrorEvent(error, options.onEvent);
      throw error;
    }
  }

  // Reaching here means every iteration was spent with the model still asking
  // for tools (any other exit breaks or returns above): the cap, not the
  // model, ended this turn. Say so explicitly so the UI can offer to continue.
  if (stopReason === "tool_use" && !options.signal?.aborted) {
    options.onEvent?.({ type: "iteration_limit", iterations: maxToolIterations });
  }

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

async function runTools(
  calls: Extract<ContentBlock, { type: "tool_call" }>[],
  options: RunTurnOptions,
  malformedCalls: ReadonlyMap<string, string>,
  signal: AbortSignal | undefined,
): Promise<ContentBlock[]> {
  const results: Array<Extract<ContentBlock, { type: "tool_result" }>> = [];

  for (const call of calls) {
    // A call whose streamed arguments never parsed (even after repair) gets a
    // per-call error instead of running the handler on garbage input.
    const malformed = malformedCalls.get(call.id);
    const result: { content: string; isError: boolean; images?: ImageBlock[] } = malformed
      ? { content: malformed, isError: true }
      : await executeOne(
          options.tools.find((t) => t.name === call.name),
          call,
          options,
          signal,
        );
    options.onEvent?.({
      type: "tool_result",
      id: call.id,
      content: result.content,
      isError: result.isError,
      images: result.images,
    });
    results.push({
      type: "tool_result",
      toolCallId: call.id,
      content: result.content,
      isError: result.isError,
      ...(result.images?.length ? { images: result.images } : {}),
    });
  }

  // The event above streams full content to the TUI; only the conversation is capped.
  return truncateToolResults(results);
}

async function executeOne(
  spec: ToolSpec | undefined,
  call: Extract<ContentBlock, { type: "tool_call" }>,
  options: RunTurnOptions,
  signal: AbortSignal | undefined,
): Promise<{ content: string; isError: boolean; images?: ImageBlock[] }> {
  let resolved = spec;
  if (!resolved) {
    // Tool-call repair: providers occasionally mangle tool-name casing; fall back to a
    // case-insensitive match. Mismatch repair for "${call.name}" is silent by design (no log dependency).
    resolved = options.tools.find((t) => t.name.toLowerCase() === call.name.toLowerCase());
  }
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
      const verdict = await options.toolPolicy.check(
        { tool: resolved.name, riskTier: resolved.riskTier, ...subject },
        options.requestApproval,
      );
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

  const toolSignal = signal ?? NEVER_ABORTED;
  const toolCtx = {
    signal: toolSignal,
    turnId: options.turnId,
    cwd: options.cwd,
    sessionId: options.sessionId,
    toolCallId: call.id,
    requestApproval: options.requestApproval,
  };
  try {
    const result = await resolved.handler(call.input, toolCtx);
    return { content: result.content, isError: result.isError ?? false, images: result.images };
  } catch (error) {
    return { content: error instanceof Error ? error.message : String(error), isError: true };
  }
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
        // Attach to the trailing thinking block, creating a placeholder when
        // the provider sent the signature without streamed thinking text.
        const last = content[content.length - 1];
        if (last?.type === "thinking" && last.signature === undefined) {
          last.signature = event.signature;
        } else if (last?.type !== "thinking") {
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
  if (last && last.type === type) {
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
