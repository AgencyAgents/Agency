import { randomUUID } from "node:crypto";
import type { HttpClient } from "@agency/net";
import {
  AgencyError,
  type ContentBlock,
  ErrorCode,
  type Message,
  PDF_MIME,
  type StopReason,
} from "@agency/schema";
import { parseRetryAfterMs } from "../retry-after.ts";
import { parseSse } from "../sse.ts";
import type { ProviderAdapter, ProviderRequest, StreamEvent, ThinkingLevel, Usage } from "../types.ts";

/**
 * OpenAI's reasoning_effort only has four tiers, coarser than Agency's unified
 * seven-level scale. The extra levels compress onto the nearest tier rather
 * than erroring: losing precision here is better than refusing to run.
 */
export const REASONING_EFFORT: Record<Exclude<ThinkingLevel, "off">, string> = {
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
  error: "error",
};

/** OpenRouter reads a PDF for any model, with its free engine; another OpenAI-shaped endpoint takes no file part. */
const PDF_PLUGINS = [{ id: "file-parser", pdf: { engine: "cloudflare-ai" } }];

function toOpenAiContent(content: ContentBlock[], files = false): string | Record<string, unknown>[] {
  const parts: Record<string, unknown>[] = [];
  for (const block of content) {
    if (block.type === "text") {
      parts.push({ type: "text", text: block.text });
    } else if (block.type === "image" && block.mimeType === PDF_MIME) {
      parts.push(
        files
          ? {
              type: "file",
              file: { filename: "document.pdf", file_data: `data:${PDF_MIME};base64,${block.data}` },
            }
          : { type: "text", text: "[A PDF was left out: this provider takes no PDF.]" },
      );
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

function toOpenAiMessages(
  messages: Message[],
  system?: string,
  vision = false,
  files = false,
): Record<string, unknown>[] {
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
    // A tool message holds text only, so images that a tool returned follow in a user message. A PDF needs no vision.
    const images = toolResults
      .flatMap((tr) => tr.images ?? [])
      .filter((image) => vision || image.mimeType === PDF_MIME);
    if (images.length > 0) {
      out.push({
        role: "user",
        content: toOpenAiContent(
          [{ type: "text", text: "Attachments of the tool results above." }, ...images],
          files,
        ),
      });
    }
    // A text of the harness next to the results (a compaction prompt, a note) follows them as a user message.
    const rest = toolResults.length > 0 ? m.content.filter((b) => b.type !== "tool_result") : m.content;
    if (rest.length === 0) continue;

    out.push({ role: m.role, content: toOpenAiContent(rest, files) });
  }

  return out;
}

function buildRequestBody(request: ProviderRequest, family: string): Record<string, unknown> {
  const files = family === "openrouter";
  // No explicit cache markers: OpenAI's prompt caching is automatic (and
  // chat-completions has no cache_control parameter), so keeping the system
  // prompt and tool definitions as a stable request prefix is what earns
  // cache hits here — the same stable-boundary rule the Anthropic adapter
  // marks explicitly.
  const body: Record<string, unknown> = {
    model: request.model,
    messages: toOpenAiMessages(request.messages, request.system, request.vision, files),
    max_completion_tokens: request.maxTokens,
    stream: true,
    stream_options: { include_usage: true },
  };
  // Claude caches only with a marker. OpenRouter's top-level one sets the breakpoint on the last block, so each request
  // of a turn reads the cache up to the request before it.
  if (family === "openrouter" && request.model.startsWith("anthropic/"))
    body.cache_control = { type: "ephemeral" };
  // Other servers of this format may refuse a field they do not know.
  if (family === "openai" && request.cacheKey !== undefined) body.prompt_cache_key = request.cacheKey;

  if (request.tools?.length) {
    body.tools = request.tools.map((t) => ({
      type: "function",
      function: { name: t.name, description: t.description, parameters: t.inputSchema },
    }));
  }

  const hasPdf = request.messages.some((m) =>
    m.content.some(
      (block) =>
        (block.type === "image" && block.mimeType === PDF_MIME) ||
        (block.type === "tool_result" && block.images?.some((image) => image.mimeType === PDF_MIME)),
    ),
  );
  if (files && hasPdf) body.plugins = PDF_PLUGINS;
  if (request.temperature !== undefined) body.temperature = request.temperature;
  const effort = reasoningEffort(request);
  if (effort) body.reasoning_effort = effort;

  return body;
}

/** A level the model lists goes out unchanged: the catalog knows models past high that the scale above lowers. */
export function reasoningEffort(request: ProviderRequest): string | undefined {
  const level = request.thinkingLevel;
  if (!level || level === "off") return undefined;
  return request.efforts?.includes(level) ? level : REASONING_EFFORT[level];
}

export async function toAgencyError(res: Response, family: string): Promise<AgencyError> {
  const body = (await res.json().catch(() => undefined)) as
    | {
        error?: {
          message?: string;
          code?: string;
          type?: string;
          metadata?: { raw?: unknown; provider_name?: string };
        };
      }
    | undefined;
  // OpenRouter says only "Provider returned error" and puts the upstream's cause in the metadata.
  const meta = body?.error?.metadata;
  const stated = body?.error?.message ?? res.statusText;
  const from = meta?.provider_name ? ` (${meta.provider_name})` : "";
  const message = typeof meta?.raw === "string" ? `${stated}${from}: ${meta.raw.slice(0, 500)}` : stated;
  const context = { status: res.status, source: family };

  if (res.status === 401 || res.status === 403) {
    // A provider's own text ("User not found.") does not say which key failed.
    const what = res.status === 401 ? "rejected the API key" : "refused access";
    const text = `${family} ${what} (HTTP ${res.status}): ${message}`;
    return new AgencyError(ErrorCode.AUTH, text, { source: family, context });
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
    body?.error?.type === "exceed_context_size_error" ||
    /(context length|maximum context|context size|too many (input )?tokens|input (is )?too long|request too large)/i.test(
      message,
    )
  ) {
    return new AgencyError(ErrorCode.CONTEXT_OVERFLOW, message, { source: family, context });
  }
  if (res.status >= 500) {
    return new AgencyError(ErrorCode.TRANSIENT, message, { source: family, context });
  }
  // What is left of the 4xx range is a request that the caller can correct: an unknown model, a bad parameter.
  const code = res.status >= 400 ? ErrorCode.INVALID_REQUEST : ErrorCode.INTERNAL;
  return new AgencyError(code, message, { source: family, context });
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
    body: JSON.stringify(buildRequestBody(request, family)),
    signal: request.signal,
  });

  if (!res.ok || !res.body) {
    throw await toAgencyError(res, family);
  }

  // OpenAI addresses parallel tool calls by delta index, not id: the id only
  // appears once, on the first delta for that index.
  const toolCallIdByIndex = new Map<number, string>();
  let usage: Usage = { inputTokens: 0, outputTokens: 0 };
  let stopReason: StopReason = "end_turn";
  let finished = false;
  let refused = false;

  for await (const frame of parseSse(res.body)) {
    if (frame.data === "[DONE]") continue;
    const payload = JSON.parse(frame.data) as {
      /** OpenRouter: a failure after the stream began. The HTTP status is 200 by then. */
      error?: { code?: unknown };
      choices: Array<{
        delta: {
          content?: string;
          /** A refusal comes in its own field, not in `content`. */
          refusal?: string;
          /** The reasoning of a reasoning model on llama.cpp, DeepSeek and others. It is shown and never sent back. */
          reasoning_content?: string;
          /** OpenRouter's name for the same text. */
          reasoning?: string | null;
          tool_calls?: Array<{
            index: number;
            id?: string;
            function?: { name?: string; arguments?: string };
          }>;
          /** Legacy streaming format: some OpenAI-compatible backends send
           *  `delta.function_call` instead of `delta.tool_calls`. Same shape
           *  as a single tool call, without the parallel-call index. */
          function_call?: { name?: string; arguments?: string };
        };
        finish_reason: string | null;
      }>;
      usage?: {
        prompt_tokens: number;
        completion_tokens: number;
        prompt_tokens_details?: { cached_tokens?: number };
        /** OpenRouter: the charge for this request in USD. */
        cost?: number;
      };
    };

    if (payload.error) {
      const code = payload.error.code;
      const status = typeof code === "number" && code >= 400 && code <= 599 ? code : 502;
      throw await toAgencyError(new Response(JSON.stringify({ error: payload.error }), { status }), family);
    }

    if (payload.usage) {
      const cachedTokens = payload.usage.prompt_tokens_details?.cached_tokens;
      usage = {
        inputTokens: payload.usage.prompt_tokens,
        outputTokens: payload.usage.completion_tokens,
        ...(cachedTokens === undefined ? {} : { cachedInputTokens: cachedTokens }),
        ...(typeof payload.usage.cost === "number" ? { costUsd: payload.usage.cost } : {}),
      };
    }

    const choice = payload.choices[0];
    if (!choice) continue;

    const reasoning = choice.delta.reasoning_content || choice.delta.reasoning;
    if (reasoning) yield { type: "thinking_delta", text: reasoning };
    if (choice.delta.content) {
      yield { type: "text_delta", text: choice.delta.content };
    }
    if (choice.delta.refusal) {
      refused = true;
      yield { type: "text_delta", text: choice.delta.refusal };
    }

    for (const call of choice.delta.tool_calls ?? []) {
      // The name opens a call. Some gateways send no id or an empty one: such a call gets an id here, not a silent drop.
      if (call.function?.name && !toolCallIdByIndex.has(call.index)) {
        const id = call.id || randomUUID();
        toolCallIdByIndex.set(call.index, id);
        yield { type: "tool_call_start", id, name: call.function.name };
      }
      // Independent check (not else-if): gateways may coalesce the start and
      // the first arguments chunk into a single delta carrying both id+name
      // and arguments. Dropping the args half would truncate the tool input.
      if (call.function?.arguments) {
        const id = toolCallIdByIndex.get(call.index);
        if (id) yield { type: "tool_call_delta", id, inputJsonDelta: call.function.arguments };
      }
    }

    // Legacy delta.function_call (no index, no id — single tool call).
    // The id is synthesized via UUID so downstream tool_call_end pairing and
    // the loop's tool_call collection work exactly like indexed calls.
    const fc = choice.delta.function_call;
    if (fc) {
      if (fc.name) {
        const id = randomUUID();
        toolCallIdByIndex.set(-1, id);
        yield { type: "tool_call_start", id, name: fc.name };
      }
      // Same coalescing rule as above: a single legacy delta may carry both
      // the name and the first arguments chunk. Look the id back up when the
      // name arrived in this same frame.
      if (fc.arguments) {
        const id = toolCallIdByIndex.get(-1);
        if (id) yield { type: "tool_call_delta", id, inputJsonDelta: fc.arguments };
      }
    }

    if (choice.finish_reason) {
      stopReason = FINISH_REASON[choice.finish_reason] ?? "end_turn";
      // OpenRouter repeats the finish reason on its usage chunk. A call that ends twice runs twice.
      if (!finished) for (const id of toolCallIdByIndex.values()) yield { type: "tool_call_end", id };
      finished = true;
    }
  }

  // No finish reason arrived: the open calls still close, so their arguments are checked and answered.
  if (!finished) for (const id of toolCallIdByIndex.values()) yield { type: "tool_call_end", id };

  // Some servers send a tool call and then finish with "stop": the calls decide, or the loop would not run them.
  if (toolCallIdByIndex.size > 0 && stopReason === "end_turn") stopReason = "tool_use";
  if (refused && stopReason === "end_turn") stopReason = "refusal";
  yield { type: "message_stop", stopReason, usage };
}

export function createOpenAiCompatibleAdapter(family: string, baseUrl: string): ProviderAdapter {
  return {
    family,
    stream: (request, http) => streamRaw(request, http, family, baseUrl),
  };
}
