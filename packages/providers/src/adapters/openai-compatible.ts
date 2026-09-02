import type { HttpClient } from "@agency/net";
import { AgencyError, type ContentBlock, ErrorCode, type Message, type StopReason } from "@agency/schema";
import { parseRetryAfterMs } from "../retry-after.ts";
import { parseSse } from "../sse.ts";
import type { ProviderAdapter, ProviderRequest, StreamEvent, ThinkingLevel } from "../types.ts";

/**
 * OpenAI's reasoning_effort only has four tiers, coarser than Agency's unified
 * seven-level scale. The extra levels compress onto the nearest tier rather
 * than erroring: losing precision here is better than refusing to run.
 */
const REASONING_EFFORT: Record<Exclude<ThinkingLevel, "off">, string> = {
  minimal: "minimal",
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "high",
  max: "high",
};

const FINISH_REASON: Record<string, StopReason> = {
  stop: "end_turn",
  tool_calls: "tool_use",
  function_call: "tool_use",
  length: "max_tokens",
  content_filter: "refusal",
};

function toOpenAiContent(content: ContentBlock[]): string | Record<string, unknown>[] {
  const parts: Record<string, unknown>[] = [];
  for (const block of content) {
    if (block.type === "text") {
      parts.push({ type: "text", text: block.text });
    } else if (block.type === "image") {
      parts.push({
        type: "image_url",
        image_url: { url: `data:${block.mimeType};base64,${block.data}` },
      });
    }
  }
  if (parts.length === 0) return "";
  if (parts.length === 1 && parts[0]?.type === "text") return String(parts[0].text);
  return parts;
}

function textOf(content: ContentBlock[]): string {
  return content
    .filter((b): b is Extract<ContentBlock, { type: "text" }> => b.type === "text")
    .map((b) => b.text)
    .join("");
}

function toOpenAiMessages(messages: Message[], system?: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  if (system) out.push({ role: "system", content: system });

  for (const m of messages) {
    const toolCalls = m.content.filter((b) => b.type === "tool_call");
    const toolResults = m.content.filter((b) => b.type === "tool_result");

    if (toolCalls.length > 0) {
      out.push({
        role: "assistant",
        content: textOf(m.content) || null,
        tool_calls: toolCalls.map((tc) => ({
          id: tc.id,
          type: "function",
          function: { name: tc.name, arguments: JSON.stringify(tc.input) },
        })),
      });
      continue;
    }

    for (const tr of toolResults) {
      out.push({ role: "tool", tool_call_id: tr.toolCallId, content: tr.content });
    }
    if (toolResults.length > 0) continue;

    out.push({ role: m.role, content: toOpenAiContent(m.content) });
  }

  return out;
}

function buildRequestBody(request: ProviderRequest): Record<string, unknown> {
  // No explicit cache markers: OpenAI's prompt caching is automatic (and
  // chat-completions has no cache_control parameter), so keeping the system
  // prompt and tool definitions as a stable request prefix is what earns
  // cache hits here — the same stable-boundary rule the Anthropic adapter
  // marks explicitly.
  const body: Record<string, unknown> = {
    model: request.model,
    messages: toOpenAiMessages(request.messages, request.system),
    max_completion_tokens: request.maxTokens,
    stream: true,
    stream_options: { include_usage: true },
  };

  if (request.tools?.length) {
    body.tools = request.tools.map((t) => ({
      type: "function",
      function: { name: t.name, description: t.description, parameters: t.inputSchema },
    }));
  }

  if (request.temperature !== undefined) body.temperature = request.temperature;
  if (request.thinkingLevel && request.thinkingLevel !== "off") {
    body.reasoning_effort = REASONING_EFFORT[request.thinkingLevel];
  }

  return body;
}

async function toAgencyError(res: Response, family: string): Promise<AgencyError> {
  const body = (await res.json().catch(() => undefined)) as
    | { error?: { message?: string; code?: string; type?: string } }
    | undefined;
  const message = body?.error?.message ?? res.statusText;
  const context = { status: res.status, source: family };

  if (res.status === 401 || res.status === 403) {
    return new AgencyError(ErrorCode.AUTH, message, { source: family, context });
  }
  if (res.status === 429) {
    const retryAfterMs = parseRetryAfterMs(res);
    return new AgencyError(ErrorCode.RATE_LIMIT, message, {
      source: family,
      context: retryAfterMs === undefined ? context : { ...context, retryAfterMs },
    });
  }
  // Not every OpenAI-shaped endpoint uses the `context_length_exceeded` code
  // (OpenAI itself phrases it as a message, vLLM/llama.cpp vary), so the
  // status code and message text back the structured code up.
  if (
    res.status === 413 ||
    body?.error?.code === "context_length_exceeded" ||
    /(context length|maximum context|too many (input )?tokens|input (is )?too long|request too large)/i.test(
      message,
    )
  ) {
    return new AgencyError(ErrorCode.CONTEXT_OVERFLOW, message, { source: family, context });
  }
  if (res.status >= 500) {
    return new AgencyError(ErrorCode.TRANSIENT, message, { source: family, context });
  }
  return new AgencyError(ErrorCode.INTERNAL, message, { source: family, context });
}

async function* streamRaw(
  request: ProviderRequest,
  http: HttpClient,
  family: string,
  baseUrl: string,
): AsyncIterable<StreamEvent> {
  const effectiveBaseUrl = request.baseUrl ?? baseUrl;
  const res = await http.fetch(`${effectiveBaseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${request.apiKey}`,
      ...request.headers,
    },
    body: JSON.stringify(buildRequestBody(request)),
    signal: request.signal,
  });

  if (!res.ok || !res.body) {
    throw await toAgencyError(res, family);
  }

  // OpenAI addresses parallel tool calls by delta index, not id: the id only
  // appears once, on the first delta for that index.
  const toolCallIdByIndex = new Map<number, string>();
  let usage: {
    inputTokens: number;
    outputTokens: number;
    cachedInputTokens?: number;
  } = { inputTokens: 0, outputTokens: 0 };
  let stopReason: StopReason = "end_turn";

  for await (const frame of parseSse(res.body)) {
    if (frame.data === "[DONE]") continue;
    const payload = JSON.parse(frame.data) as {
      choices: Array<{
        delta: {
          content?: string;
          tool_calls?: Array<{
            index: number;
            id?: string;
            function?: { name?: string; arguments?: string };
          }>;
        };
        finish_reason: string | null;
      }>;
      usage?: {
        prompt_tokens: number;
        completion_tokens: number;
        prompt_tokens_details?: { cached_tokens?: number };
      };
    };

    if (payload.usage) {
      const cachedTokens = payload.usage.prompt_tokens_details?.cached_tokens;
      usage = {
        inputTokens: payload.usage.prompt_tokens,
        outputTokens: payload.usage.completion_tokens,
        ...(cachedTokens === undefined ? {} : { cachedInputTokens: cachedTokens }),
      };
    }

    const choice = payload.choices[0];
    if (!choice) continue;

    if (choice.delta.content) {
      yield { type: "text_delta", text: choice.delta.content };
    }

    for (const call of choice.delta.tool_calls ?? []) {
      if (call.id && call.function?.name) {
        toolCallIdByIndex.set(call.index, call.id);
        yield { type: "tool_call_start", id: call.id, name: call.function.name };
      } else if (call.function?.arguments) {
        const id = toolCallIdByIndex.get(call.index);
        if (id) yield { type: "tool_call_delta", id, inputJsonDelta: call.function.arguments };
      }
    }

    if (choice.finish_reason) {
      stopReason = FINISH_REASON[choice.finish_reason] ?? "end_turn";
      for (const id of toolCallIdByIndex.values()) yield { type: "tool_call_end", id };
    }
  }

  yield { type: "message_stop", stopReason, usage };
}

export function createOpenAiCompatibleAdapter(family: string, baseUrl: string): ProviderAdapter {
  return {
    family,
    stream: (request, http) => streamRaw(request, http, family, baseUrl),
  };
}
