import type { HttpClient } from "@agency/net";
import { AgencyError, type ContentBlock, ErrorCode, type StopReason } from "@agency/schema";
import { estimateTokens, MIN_CACHEABLE_TOKENS, splitStableDynamic } from "../cache-policy.ts";
import { parseRetryAfterMs } from "../retry-after.ts";
import { parseSse } from "../sse.ts";
import type { ProviderAdapter, ProviderRequest, StreamEvent, ThinkingLevel } from "../types.ts";

const API_VERSION = "2023-06-01";
const BASE_URL = "https://api.anthropic.com/v1/messages";

/** Anthropic's `thinking.budget_tokens` per unified level. `off` omits the block entirely. */
const THINKING_BUDGET: Record<Exclude<ThinkingLevel, "off">, number> = {
  minimal: 1024,
  low: 2048,
  medium: 4096,
  high: 8192,
  xhigh: 16384,
  max: 32000,
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

/** Anthropic phrases oversized inputs as a 400 invalid_request_error (or 413). */
function isInputTooLong(status: number, message: string): boolean {
  return (
    status === 413 ||
    (status === 400 &&
      /(prompt is too long|input length[^\n]*exceeds|exceeds the context|context length|too many (input )?tokens|request too large)/i.test(
        message,
      ))
  );
}

function toAnthropicContent(block: ContentBlock): Record<string, unknown> | undefined {
  switch (block.type) {
    case "text":
      return { type: "text", text: block.text };
    case "image":
      return { type: "image", source: { type: "base64", media_type: block.mimeType, data: block.data } };
    case "tool_call":
      return { type: "tool_use", id: block.id, name: block.name, input: block.input };
    case "tool_result":
      return {
        type: "tool_result",
        tool_use_id: block.toolCallId,
        content: block.content,
        is_error: block.isError || undefined,
      };
    case "thinking":
      // Unsigned thinking can't be replayed (the API rejects it), so it only
      // goes back when the signature the provider issued for it is present.
      return block.signature === undefined
        ? undefined
        : { type: "thinking", thinking: block.text, signature: block.signature };
    case "redacted_thinking":
      return { type: "redacted_thinking", data: block.data };
  }
}

function buildRequestBody(request: ProviderRequest): Record<string, unknown> {
  const minTokens = request.cachePolicy?.minTokens ?? MIN_CACHEABLE_TOKENS;
  const messages: { role: string; content: Record<string, unknown>[]; cache_control?: unknown }[] =
    request.messages.map((m) => ({
      role: m.role === "system" ? "user" : m.role,
      content: m.content.map(toAnthropicContent).filter((c): c is Record<string, unknown> => c !== undefined),
    }));

  // Breakpoints 3 and 4 roll forward: the settled turn-back tail and the
  // current tail. Each is skipped when the conversation is too short to pay.
  const userIdx = messages
    .map((m, i) => (m.role === "user" && m.content.length > 0 ? i : -1))
    .filter((i) => i >= 0);
  const prefixTokens = (through: number): number =>
    estimateTokens(JSON.stringify(messages.slice(0, through + 1)));
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

  const body: Record<string, unknown> = {
    model: request.model,
    max_tokens: request.maxTokens,
    stream: true,
  };

  if (request.tools?.length) {
    const tools: { name: string; description?: string; input_schema: unknown; cache_control?: unknown }[] =
      request.tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.inputSchema,
      }));
    if (estimateTokens(JSON.stringify(tools)) >= minTokens) {
      const lastTool = tools.at(-1);
      if (lastTool) lastTool.cache_control = { type: "ephemeral" };
    }
    body.tools = tools;
  }

  if (request.systemSegments) {
    const { stable, dynamic } = splitStableDynamic(request.systemSegments);
    const system: Record<string, unknown>[] = [];
    if (stable) {
      system.push(
        estimateTokens(stable) >= minTokens
          ? { type: "text", text: stable, cache_control: { type: "ephemeral", ttl: "1h" } }
          : { type: "text", text: stable },
      );
    }
    if (dynamic) system.push({ type: "text", text: dynamic });
    if (system.length > 0) body.system = system;
  } else if (request.system) {
    body.system = [{ type: "text", text: request.system, cache_control: { type: "ephemeral" } }];
  }

  body.messages = messages;

  if (request.temperature !== undefined) body.temperature = request.temperature;

  if (request.thinkingLevel && request.thinkingLevel !== "off") {
    body.thinking = { type: "enabled", budget_tokens: THINKING_BUDGET[request.thinkingLevel] };
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
    return new AgencyError(ErrorCode.AUTH, message, { source: "anthropic", context });
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
  if (isInputTooLong(res.status, message)) {
    return new AgencyError(ErrorCode.CONTEXT_OVERFLOW, message, { source: "anthropic", context });
  }
  return new AgencyError(ErrorCode.INTERNAL, message, { source: "anthropic", context });
}

async function* streamRaw(request: ProviderRequest, http: HttpClient): AsyncIterable<StreamEvent> {
  const res = await http.fetch(BASE_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": request.apiKey,
      "anthropic-version": API_VERSION,
    },
    body: JSON.stringify(buildRequestBody(request)),
    signal: request.signal,
  });

  if (!res.ok || !res.body) {
    throw await toAgencyError(res);
  }

  // index -> tool_call id, so content_block_delta/stop can address the right call
  const toolCallIndex = new Map<number, string>();
  const usage: {
    inputTokens: number;
    outputTokens: number;
    cachedInputTokens?: number;
    cacheWriteInputTokens?: number;
  } = {
    inputTokens: 0,
    outputTokens: 0,
  };
  let stopReason: StopReason = "end_turn";

  for await (const frame of parseSse(res.body)) {
    if (frame.data === "[DONE]") continue;
    const payload = JSON.parse(frame.data) as Record<string, unknown>;

    switch (payload.type) {
      case "message_start": {
        const msgUsage = (
          payload.message as {
            usage?: {
              input_tokens?: number;
              cache_read_input_tokens?: number;
              cache_creation_input_tokens?: number;
            };
          }
        )?.usage;
        usage.inputTokens = msgUsage?.input_tokens ?? 0;
        if (msgUsage?.cache_read_input_tokens !== undefined) {
          usage.cachedInputTokens = msgUsage.cache_read_input_tokens;
        }
        if (msgUsage?.cache_creation_input_tokens !== undefined) {
          usage.cacheWriteInputTokens = msgUsage.cache_creation_input_tokens;
        }
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
        const deltaUsage = payload.usage as { output_tokens?: number } | undefined;
        if (delta.stop_reason) stopReason = STOP_REASON[delta.stop_reason] ?? "end_turn";
        if (deltaUsage?.output_tokens !== undefined) usage.outputTokens = deltaUsage.output_tokens;
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
