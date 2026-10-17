import type { HttpClient } from "@agency/net";
import { AgencyError, type ContentBlock, ErrorCode, PDF_MIME, type StopReason } from "@agency/schema";
import { estimateTokens, MIN_CACHEABLE_TOKENS, splitStableDynamic } from "../cache-policy.ts";
import { parseRetryAfterMs } from "../retry-after.ts";
import { parseSse } from "../sse.ts";
import type { ProviderAdapter, ProviderRequest, StreamEvent, ThinkingLevel, Usage } from "../types.ts";

const API_VERSION = "2023-06-01";
const BASE_URL = "https://api.anthropic.com/v1";

/** Anthropic's `thinking.budget_tokens` per unified level. `off` omits the block entirely. */
const THINKING_BUDGET: Record<Exclude<ThinkingLevel, "off">, number> = {
  minimal: 1024,
  low: 2048,
  medium: 4096,
  high: 8192,
  xhigh: 16384,
  max: 32000,
};

/** The 4.5 family and older models take a thinking budget and answer 400 to adaptive thinking. Later models are the reverse. */
const BUDGET_THINKING_MODEL = /claude-(?:3-|(?:opus|sonnet|haiku)-4-(?:[15](?!\d)|\d{8}))/;

/** `output_config.effort` per unified level, for the models with adaptive thinking. */
const EFFORT: Record<Exclude<ThinkingLevel, "off">, string> = {
  minimal: "low",
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "xhigh",
  max: "max",
};

const STOP_REASON: Record<string, StopReason> = {
  end_turn: "end_turn",
  tool_use: "tool_use",
  max_tokens: "max_tokens",
  stop_sequence: "stop_sequence",
  refusal: "refusal",
  // The model paused a long-running server-side turn and expects the response
  // replayed to continue it; Agency has no provider-driven continuation, so
  // the turn ends with what was streamed and the user's next message resumes.
  pause_turn: "end_turn",
};

/** Anthropic phrases oversized inputs as a 400 invalid_request_error (or 413). A llama.cpp server has its own type. */
function isInputTooLong(status: number, message: string, type?: string): boolean {
  return (
    status === 413 ||
    type === "exceed_context_size_error" ||
    (status === 400 &&
      /(prompt is too long|input length[^\n]*exceeds|exceeds the context|context length|too many (input )?tokens|request too large)/i.test(
        message,
      ))
  );
}

function toAnthropicContent(block: ContentBlock, vision = false): Record<string, unknown> | undefined {
  switch (block.type) {
    case "text":
      return { type: "text", text: block.text };
    case "image":
      return block.mimeType === PDF_MIME
        ? { type: "document", source: { type: "base64", media_type: PDF_MIME, data: block.data } }
        : { type: "image", source: { type: "base64", media_type: block.mimeType, data: block.data } };
    case "tool_call":
      return { type: "tool_use", id: block.id, name: block.name, input: block.input };
    case "tool_result": {
      // A PDF goes to every model; an image only to one that sees images.
      const attached = (block.images ?? []).filter((image) => vision || image.mimeType === PDF_MIME);
      return {
        type: "tool_result",
        tool_use_id: block.toolCallId,
        content:
          attached.length > 0
            ? [{ type: "text", text: block.content }, ...attached.map((image) => toAnthropicContent(image))]
            : block.content,
        is_error: block.isError || undefined,
      };
    }
    case "thinking":
      // Unsigned thinking can't be replayed (the API rejects it), and neither can
      // a signature that another provider issued.
      return block.signature === undefined || (block.family ?? "anthropic") !== "anthropic"
        ? undefined
        : { type: "thinking", thinking: block.text, signature: block.signature };
    case "redacted_thinking":
      return { type: "redacted_thinking", data: block.data };
  }
}

function buildRequestBody(request: ProviderRequest): Record<string, unknown> {
  const minTokens = request.cachePolicy?.minTokens ?? MIN_CACHEABLE_TOKENS;
  // A message that maps to no content is left out: the API rejects an empty message.
  const messages: { role: string; content: Record<string, unknown>[]; cache_control?: unknown }[] =
    request.messages
      .map((m) => ({
        role: m.role === "system" ? "user" : m.role,
        content: m.content
          .map((block) => toAnthropicContent(block, request.vision))
          .filter((c): c is Record<string, unknown> => c !== undefined),
      }))
      .filter((m) => m.content.length > 0);

  const body: Record<string, unknown> = {
    model: request.model,
    max_tokens: request.maxTokens,
    stream: true,
  };

  // The minimum cacheable size counts the whole prefix up to a mark (tools, then system, then messages), not one part.
  const tools = request.tools?.map(
    (t): { name: string; description?: string; input_schema: unknown; cache_control?: unknown } => ({
      name: t.name,
      description: t.description,
      input_schema: t.inputSchema,
    }),
  );
  const toolTokens = tools?.length ? estimateTokens(JSON.stringify(tools)) : 0;
  const { stable, dynamic } = request.systemSegments
    ? splitStableDynamic(request.systemSegments)
    : { stable: "", dynamic: "" };
  const stableMarked = stable !== "" && toolTokens + estimateTokens(stable) >= minTokens;

  if (tools?.length) {
    if (toolTokens >= minTokens) {
      // The API wants a 1-hour entry before any 5-minute one, and tools come before the system text.
      const lastTool = tools.at(-1);
      if (lastTool)
        lastTool.cache_control = stableMarked ? { type: "ephemeral", ttl: "1h" } : { type: "ephemeral" };
    }
    body.tools = tools;
  }

  let systemTokens = 0;
  if (request.systemSegments) {
    const system: Record<string, unknown>[] = [];
    if (stable) {
      system.push(
        stableMarked
          ? { type: "text", text: stable, cache_control: { type: "ephemeral", ttl: "1h" } }
          : { type: "text", text: stable },
      );
    }
    if (dynamic) system.push({ type: "text", text: dynamic });
    if (system.length > 0) body.system = system;
    systemTokens = estimateTokens(stable) + estimateTokens(dynamic);
  } else if (request.system) {
    body.system = [{ type: "text", text: request.system, cache_control: { type: "ephemeral" } }];
    systemTokens = estimateTokens(request.system);
  }

  // Breakpoints 3 and 4 roll forward: the settled turn-back tail and the
  // current tail. Each is skipped when the prefix is too short to pay.
  const userIdx = messages
    .map((m, i) => (m.role === "user" && m.content.length > 0 ? i : -1))
    .filter((i) => i >= 0);
  const prefixTokens = (through: number): number =>
    toolTokens + systemTokens + estimateTokens(JSON.stringify(messages.slice(0, through + 1)));
  const lastIdx = userIdx.at(-1);
  const lastTail = lastIdx !== undefined ? messages[lastIdx]?.content.at(-1) : undefined;
  if (lastIdx !== undefined && lastTail && prefixTokens(lastIdx) >= minTokens) {
    lastTail.cache_control = { type: "ephemeral" };
  }
  if (userIdx.length >= 2) {
    const settledIdx = userIdx.at(-2);
    if (settledIdx !== undefined && prefixTokens(settledIdx) >= minTokens) {
      const settledBlock = messages[settledIdx]?.content.at(-1);
      if (settledBlock && settledBlock !== lastTail) {
        settledBlock.cache_control = { type: "ephemeral" };
      }
    }
  }

  body.messages = messages;

  if (request.temperature !== undefined) body.temperature = request.temperature;

  if (request.thinkingLevel && request.thinkingLevel !== "off") {
    if (BUDGET_THINKING_MODEL.test(request.model)) {
      // The API takes a budget of 1024 or more that is less than max_tokens. Half of max_tokens leaves room for the answer.
      const budget = Math.min(THINKING_BUDGET[request.thinkingLevel], Math.floor(request.maxTokens / 2));
      if (budget >= 1024) body.thinking = { type: "enabled", budget_tokens: budget };
    } else {
      // These models hide the thinking text unless the request asks for the summary. The 4.6 models have no xhigh.
      const noXhigh = request.thinkingLevel === "xhigh" && /-4-6(?!\d)/.test(request.model);
      body.thinking = { type: "adaptive", display: "summarized" };
      body.output_config = { effort: noXhigh ? "high" : EFFORT[request.thinkingLevel] };
    }
  }

  return body;
}

async function toAgencyError(res: Response): Promise<AgencyError> {
  const body = (await res.json().catch(() => undefined)) as
    | { error?: { type?: string; message?: string } }
    | undefined;
  const message = body?.error?.message ?? res.statusText;
  const context = { status: res.status, source: "anthropic" };

  if (res.status === 401 || res.status === 403) {
    // A provider's own text ("User not found.") does not say which key failed.
    const what = res.status === 401 ? "rejected the API key" : "refused access";
    const text = `anthropic ${what} (HTTP ${res.status}): ${message}`;
    return new AgencyError(ErrorCode.AUTH, text, { source: "anthropic", context });
  }
  if (res.status === 429) {
    const retryAfterMsValue = parseRetryAfterMs(res);
    return new AgencyError(ErrorCode.RATE_LIMIT, message, {
      source: "anthropic",
      context: retryAfterMsValue === undefined ? context : { ...context, retryAfterMs: retryAfterMsValue },
    });
  }
  if (res.status === 529) {
    return new AgencyError(ErrorCode.OVERLOAD, message, { source: "anthropic", context });
  }
  if (res.status >= 500) {
    return new AgencyError(ErrorCode.TRANSIENT, message, { source: "anthropic", context });
  }
  if (isInputTooLong(res.status, message, body?.error?.type)) {
    return new AgencyError(ErrorCode.CONTEXT_OVERFLOW, message, { source: "anthropic", context });
  }
  // What is left of the 4xx range is a request that the caller can correct: an unknown model, a bad parameter.
  const code = res.status >= 400 ? ErrorCode.INVALID_REQUEST : ErrorCode.INTERNAL;
  return new AgencyError(code, message, { source: "anthropic", context });
}

interface WireUsage {
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
  /** The charge in USD. A gateway (OpenRouter) sends it. */
  cost?: number | null;
}

/**
 * message_delta repeats the counts as totals, and a gateway sends zero in message_start and the real counts there.
 * The wire counts are additive: `inputTokens` is the whole prompt, and the cost formula takes the cached parts out.
 */
function readUsage(usage: Usage, wire: WireUsage | undefined): void {
  if (typeof wire?.output_tokens === "number") usage.outputTokens = wire.output_tokens;
  if (typeof wire?.cost === "number") usage.costUsd = wire.cost;
  const cached = wire?.cache_read_input_tokens;
  const written = wire?.cache_creation_input_tokens;
  const total = (wire?.input_tokens ?? 0) + (cached ?? 0) + (written ?? 0);
  if (total === 0) return;
  usage.inputTokens = total;
  if (typeof cached === "number") usage.cachedInputTokens = cached;
  if (typeof written === "number") usage.cacheWriteInputTokens = written;
}

async function* streamRaw(request: ProviderRequest, http: HttpClient): AsyncIterable<StreamEvent> {
  const res = await http.fetch(`${request.baseUrl ?? BASE_URL}/messages`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": request.apiKey,
      "anthropic-version": API_VERSION,
      ...request.headers,
    },
    body: JSON.stringify(buildRequestBody(request)),
    signal: request.signal,
  });

  if (!res.ok || !res.body) {
    throw await toAgencyError(res);
  }

  // index -> tool_call id, so content_block_delta/stop can address the right call
  const toolCallIndex = new Map<number, string>();
  const usage: Usage = { inputTokens: 0, outputTokens: 0 };
  let stopReason: StopReason = "end_turn";

  for await (const frame of parseSse(res.body)) {
    if (frame.data === "[DONE]") continue;
    const payload = JSON.parse(frame.data) as Record<string, unknown>;

    switch (payload.type) {
      case "message_start": {
        readUsage(usage, (payload.message as { usage?: WireUsage })?.usage);
        break;
      }
      case "content_block_start": {
        const block = payload.content_block as {
          type: string;
          id?: string;
          name?: string;
          data?: string;
        };
        const index = payload.index as number;
        if (block.type === "tool_use" && block.id && block.name) {
          toolCallIndex.set(index, block.id);
          yield { type: "tool_call_start", id: block.id, name: block.name };
        } else if (block.type === "redacted_thinking" && typeof block.data === "string") {
          yield { type: "redacted_thinking", data: block.data };
        }
        break;
      }
      case "content_block_delta": {
        const delta = payload.delta as {
          type: string;
          text?: string;
          thinking?: string;
          signature?: string;
          partial_json?: string;
        };
        const index = payload.index as number;
        if (delta.type === "text_delta" && delta.text) {
          yield { type: "text_delta", text: delta.text };
        } else if (delta.type === "thinking_delta" && delta.thinking) {
          yield { type: "thinking_delta", text: delta.thinking };
        } else if (delta.type === "signature_delta" && delta.signature) {
          yield { type: "thinking_signature", signature: delta.signature };
        } else if (delta.type === "input_json_delta") {
          const id = toolCallIndex.get(index);
          if (id) yield { type: "tool_call_delta", id, inputJsonDelta: delta.partial_json ?? "" };
        }
        break;
      }
      case "content_block_stop": {
        const index = payload.index as number;
        const id = toolCallIndex.get(index);
        if (id) yield { type: "tool_call_end", id };
        break;
      }
      case "message_delta": {
        const delta = payload.delta as { stop_reason?: string };
        if (delta.stop_reason === "model_context_window_exceeded") {
          // Claude 4.5 and later accept a request that cannot fit, and stop the reply when the window is full.
          throw new AgencyError(
            ErrorCode.CONTEXT_OVERFLOW,
            "the context window became full during the reply",
            {
              source: "anthropic",
            },
          );
        }
        if (delta.stop_reason) stopReason = STOP_REASON[delta.stop_reason] ?? "end_turn";
        readUsage(usage, payload.usage as WireUsage | undefined);
        break;
      }
      case "message_stop": {
        yield { type: "message_stop", stopReason, usage };
        break;
      }
      case "error": {
        const err = payload.error as { type?: string; message?: string };
        throw new AgencyError(ErrorCode.TRANSIENT, err.message ?? "stream error", {
          source: "anthropic",
          context: { errorType: err.type },
        });
      }
    }
  }
}

export const anthropicAdapter: ProviderAdapter = {
  family: "anthropic",
  stream: streamRaw,
};
