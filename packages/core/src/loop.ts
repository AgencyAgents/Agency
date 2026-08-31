import type { ContentBlock, Message, StopReason } from "@agency/schema";
import type { HttpClient } from "@agency/net";
import type { CallerIdentity, Capabilities } from "@agency/guard";
import { requireTool } from "@agency/guard";
import type { ProviderAdapter, Scheduler, ThinkingLevel, Usage, ToolDefinition } from "@agency/providers";

export interface ToolHandler {
  (input: Record<string, unknown>, ctx: { signal: AbortSignal }): Promise<{ content: string; isError?: boolean }>;
}

export interface ToolSpec extends ToolDefinition {
  handler: ToolHandler;
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
  | { type: "tool_start"; id: string; name: string }
  | { type: "tool_result"; id: string; content: string; isError: boolean }
  | { type: "turn_complete"; stopReason: StopReason; usage: Usage }
  | { type: "budget_exceeded"; spentTokens: number; spentCostUsd: number };

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
  /** Caps tool-calling round-trips even when nothing else stops the run —
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
 * drives a full turn — including any tool-calling round-trips it takes to
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
    const turn = await scheduler.schedule(() =>
      collectTurn(adapter, http, {
        model: options.model,
        apiKey: options.apiKey,
        system: options.systemPrompt,
        messages,
        tools: toolDefs,
        maxTokens: options.maxTokensPerRequest ?? 8192,
        thinkingLevel: options.thinkingLevel,
        signal: options.signal,
      }, options.onEvent),
    );

    messages.push({ role: "assistant", content: turn.content });
    cumulativeUsage = addUsage(cumulativeUsage, turn.usage);
    spentCostUsd += costOf(turn.usage, options.pricePerMTok);
    stopReason = turn.stopReason;
    options.onEvent?.({ type: "turn_complete", stopReason, usage: turn.usage });

    if (exceedsBudget(cumulativeUsage, spentCostUsd, options.budget)) {
      options.onEvent?.({ type: "budget_exceeded", spentTokens: totalTokens(cumulativeUsage), spentCostUsd });
      return { messages, stopReason, usage: cumulativeUsage, budgetExceeded: true };
    }

    if (stopReason !== "tool_use" || options.signal?.aborted) break;

    const toolCalls = turn.content.filter((b): b is Extract<ContentBlock, { type: "tool_call" }> => b.type === "tool_call");
    const results = await runTools(toolCalls, options, options.signal);
    messages.push({ role: "user", content: results });
  }

  return { messages, stopReason, usage: cumulativeUsage, budgetExceeded: false };
}

async function runTools(
  calls: Extract<ContentBlock, { type: "tool_call" }>[],
  options: RunTurnOptions,
  signal: AbortSignal | undefined,
): Promise<ContentBlock[]> {
  const results: ContentBlock[] = [];

  for (const call of calls) {
    const spec = options.tools.find((t) => t.name === call.name);
    const result = await executeOne(spec, call, options, signal);
    options.onEvent?.({ type: "tool_result", id: call.id, content: result.content, isError: result.isError });
    results.push({ type: "tool_result", toolCallId: call.id, content: result.content, isError: result.isError });
  }

  return results;
}

async function executeOne(
  spec: ToolSpec | undefined,
  call: Extract<ContentBlock, { type: "tool_call" }>,
  options: RunTurnOptions,
  signal: AbortSignal | undefined,
): Promise<{ content: string; isError: boolean }> {
  if (!spec) {
    return { content: `no such tool: "${call.name}"`, isError: true };
  }

  try {
    requireTool(options.identity, options.capabilities, call.name);
  } catch (error) {
    return { content: error instanceof Error ? error.message : String(error), isError: true };
  }

  const toolSignal = signal ?? NEVER_ABORTED;
  try {
    const result = await spec.handler(call.input, { signal: toolSignal });
    return { content: result.content, isError: result.isError ?? false };
  } catch (error) {
    return { content: error instanceof Error ? error.message : String(error), isError: true };
  }
}

interface CollectedTurn {
  content: ContentBlock[];
  stopReason: StopReason;
  usage: Usage;
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
  let usage: Usage = { inputTokens: 0, outputTokens: 0 };
  let stopReason: StopReason = "end_turn";

  for await (const event of adapter.stream(request, http)) {
    switch (event.type) {
      case "text_delta":
        appendText(content, "text", event.text);
        onEvent?.({ type: "text_delta", text: event.text });
        break;
      case "thinking_delta":
        appendText(content, "thinking", event.text);
        onEvent?.({ type: "thinking_delta", text: event.text });
        break;
      case "tool_call_start":
        nameByToolId.set(event.id, event.name);
        jsonByToolId.set(event.id, "");
        onEvent?.({ type: "tool_start", id: event.id, name: event.name });
        break;
      case "tool_call_delta":
        jsonByToolId.set(event.id, (jsonByToolId.get(event.id) ?? "") + event.inputJsonDelta);
        break;
      case "tool_call_end": {
        const raw = jsonByToolId.get(event.id) ?? "{}";
        const input = raw.trim() ? (JSON.parse(raw) as Record<string, unknown>) : {};
        content.push({ type: "tool_call", id: event.id, name: nameByToolId.get(event.id) ?? "", input });
        break;
      }
      case "message_stop":
        usage = event.usage;
        stopReason = event.stopReason;
        break;
    }
  }

  return { content, stopReason, usage };
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
