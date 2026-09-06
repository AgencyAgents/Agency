import type { HttpClient } from "@agency/net";
import { AgencyError, type ContentBlock, ErrorCode, type Message, type StopReason } from "@agency/schema";
import {
  isCacheable,
  MIN_CACHEABLE_TOKENS,
  SHARED_PREFIX_TTL_SECONDS,
  splitStableDynamic,
} from "../cache-policy.ts";
import { parseRetryAfterMs } from "../retry-after.ts";
import { parseSse } from "../sse.ts";
import type { ProviderAdapter, ProviderRequest, StreamEvent, ThinkingLevel } from "../types.ts";

const BASE_URL = "https://generativelanguage.googleapis.com/v1beta/models";

/**
 * Gemini's thinkingBudget is a raw token count, with -1 meaning "let the model
 * decide" rather than a fixed ceiling, which is the natural home for our `max`.
 */
const THINKING_BUDGET: Record<ThinkingLevel, number> = {
  off: 0,
  minimal: 512,
  low: 2048,
  medium: 8192,
  high: 16384,
  xhigh: 24576,
  max: -1,
};

function toGeminiPart(block: ContentBlock): Record<string, unknown> | undefined {
  switch (block.type) {
    case "text":
      return { text: block.text };
    case "image":
      return { inlineData: { mimeType: block.mimeType, data: block.data } };
    case "tool_call":
      return { functionCall: { name: block.name, args: block.input } };
    case "tool_result":
      return { functionResponse: { name: block.toolCallId, response: { content: block.content } } };
    case "thinking":
    case "redacted_thinking":
      // Gemini rebuilds its own reasoning context; only the signed summary
      // parts it emitted matter, and those ride on the function-call parts.
      return undefined;
  }
}

function toGeminiContents(messages: Message[]): Record<string, unknown>[] {
  return messages
    .filter((m) => m.role !== "system")
    .map((m) => ({
      role: m.role === "assistant" ? "model" : "user",
      parts: m.content.map(toGeminiPart).filter((p): p is Record<string, unknown> => p !== undefined),
    }));
}

function toGeminiTools(request: ProviderRequest): Record<string, unknown>[] | undefined {
  if (!request.tools?.length) return undefined;
  return [
    {
      functionDeclarations: request.tools.map((t) => ({
        name: t.name,
        description: t.description,
        parameters: t.inputSchema,
      })),
    },
  ];
}

function buildRequestBody(
  request: ProviderRequest,
  opts: { cachedContent?: string; systemText?: string } = {},
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    contents: toGeminiContents(request.messages),
    generationConfig: {
      maxOutputTokens: request.maxTokens,
      ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
      ...(request.thinkingLevel
        ? { thinkingConfig: { thinkingBudget: THINKING_BUDGET[request.thinkingLevel] } }
        : {}),
    },
  };

  if (opts.cachedContent) body.cachedContent = opts.cachedContent;

  const system = opts.systemText ?? request.system;
  if (system) {
    body.systemInstruction = { parts: [{ text: system }] };
  }

  const tools = toGeminiTools(request);
  if (tools && !opts.cachedContent) body.tools = tools;

  return body;
}

interface PrefixCacheEntry {
  name: string;
  expiresAt: number;
}

const prefixCache = new Map<string, PrefixCacheEntry>();

function hashPrefix(model: string, text: string): string {
  let hash = 5381;
  const input = `${model}\n${text}`;
  for (let i = 0; i < input.length; i++) hash = ((hash << 5) + hash + input.charCodeAt(i)) | 0;
  return `agency-${(hash >>> 0).toString(36)}`;
}

async function explicitPrefixCache(
  request: ProviderRequest,
  http: HttpClient,
  stable: string,
  minTokens: number,
): Promise<string | undefined> {
  if (!isCacheable(stable, minTokens)) return undefined;
  const key = hashPrefix(request.model, stable);
  const hit = prefixCache.get(key);
  if (hit && hit.expiresAt > Date.now()) return hit.name;
  const ttlSeconds =
    request.systemSegments?.find((s) => s.stability !== "dynamic" && s.ttlSeconds !== undefined)
      ?.ttlSeconds ??
    request.cachePolicy?.sharedPrefixTtlSeconds ??
    SHARED_PREFIX_TTL_SECONDS;
  try {
    const res = await http.fetch(`${BASE_URL.replace("/models", "")}/cachedContents?key=${request.apiKey}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: `models/${request.model}`,
        systemInstruction: { parts: [{ text: stable }] },
        tools: toGeminiTools(request),
        ttl: `${ttlSeconds}s`,
      }),
      signal: request.signal,
    });
    if (!res.ok) return undefined;
    const payload = (await res.json().catch(() => undefined)) as { name?: string } | undefined;
    if (!payload?.name) return undefined;
    prefixCache.set(key, { name: payload.name, expiresAt: Date.now() + ttlSeconds * 1000 });
    return payload.name;
  } catch {
    return undefined;
  }
}

const FINISH_REASON: Record<string, StopReason> = {
  STOP: "end_turn",
  MAX_TOKENS: "max_tokens",
  SAFETY: "refusal",
  RECITATION: "refusal",
  BLOCKLIST: "refusal",
  PROHIBITED_CONTENT: "refusal",
  SPII: "refusal",
  MALFORMED_FUNCTION_CALL: "error",
};

/** Gemini phrases oversized inputs as a 400 INVALID_ARGUMENT (or 413). */
function isInputTooLong(status: number, message: string): boolean {
  return (
    status === 413 ||
    (status === 400 &&
      /(exceeds the maximum number of tokens|input token count|token limit|too many tokens|request too large)/i.test(
        message,
      ))
  );
}

async function toAgencyError(res: Response): Promise<AgencyError> {
  const body = (await res.json().catch(() => undefined)) as
    | { error?: { message?: string; status?: string } }
    | undefined;
  const message = body?.error?.message ?? res.statusText;
  const context = { status: res.status, source: "google" };
  const googleStatus = body?.error?.status;

  if (res.status === 401 || res.status === 403) {
    return new AgencyError(ErrorCode.AUTH, message, { source: "google", context });
  }
  if (res.status === 429 || googleStatus === "RESOURCE_EXHAUSTED") {
    const retryAfterMs = parseRetryAfterMs(res);
    return new AgencyError(ErrorCode.RATE_LIMIT, message, {
      source: "google",
      context: retryAfterMs === undefined ? context : { ...context, retryAfterMs },
    });
  }
  if (res.status >= 500) {
    return new AgencyError(ErrorCode.TRANSIENT, message, { source: "google", context });
  }
  if (isInputTooLong(res.status, message)) {
    return new AgencyError(ErrorCode.CONTEXT_OVERFLOW, message, { source: "google", context });
  }
  return new AgencyError(ErrorCode.INTERNAL, message, { source: "google", context });
}

interface GeminiPart {
  text?: string;
  thought?: boolean;
  thoughtSignature?: string;
  functionCall?: { name: string; args: Record<string, unknown> };
}

interface GeminiChunk {
  candidates?: Array<{
    content?: { parts?: GeminiPart[] };
    finishReason?: string;
  }>;
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    cachedTokenCount?: number;
  };
}

async function* streamRaw(request: ProviderRequest, http: HttpClient): AsyncIterable<StreamEvent> {
  const minTokens = request.cachePolicy?.minTokens ?? MIN_CACHEABLE_TOKENS;
  let cachedContent: string | undefined;
  let dynamicSystem: string | undefined;
  if (request.systemSegments) {
    const { stable, dynamic } = splitStableDynamic(request.systemSegments);
    cachedContent = await explicitPrefixCache(request, http, stable, minTokens);
    if (cachedContent && dynamic) dynamicSystem = dynamic;
    else if (!cachedContent) dynamicSystem = [stable, dynamic].filter(Boolean).join("\n\n") || undefined;
  }
  const url = `${BASE_URL}/${request.model}:streamGenerateContent?alt=sse&key=${request.apiKey}`;
  const res = await http.fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(
      buildRequestBody(request, cachedContent ? { cachedContent, systemText: dynamicSystem } : {}),
    ),
    signal: request.signal,
  });

  if (!res.ok || !res.body) {
    throw await toAgencyError(res);
  }

  let usage: {
    inputTokens: number;
    outputTokens: number;
    cachedInputTokens?: number;
  } = { inputTokens: 0, outputTokens: 0 };
  let stopReason: StopReason = "end_turn";
  let sawFunctionCall = false;
  let toolCallSeq = 0;

  for await (const frame of parseSse(res.body)) {
    const chunk = JSON.parse(frame.data) as GeminiChunk;
    const candidate = chunk.candidates?.[0];

    if (chunk.usageMetadata) {
      usage = {
        inputTokens: chunk.usageMetadata.promptTokenCount ?? 0,
        outputTokens: chunk.usageMetadata.candidatesTokenCount ?? 0,
        ...(chunk.usageMetadata.cachedTokenCount !== undefined
          ? { cachedInputTokens: chunk.usageMetadata.cachedTokenCount }
          : {}),
      };
    }

    for (const part of candidate?.content?.parts ?? []) {
      if (part.functionCall) {
        sawFunctionCall = true;
        // Gemini sends the whole call in one shot: there's no incremental
        // arguments stream the way Anthropic/OpenAI have, so start/delta/end
        // collapse into one immediate sequence per call.
        const id = `call_${toolCallSeq++}`;
        yield { type: "tool_call_start", id, name: part.functionCall.name };
        yield { type: "tool_call_delta", id, inputJsonDelta: JSON.stringify(part.functionCall.args) };
        yield { type: "tool_call_end", id };
      } else if (part.text && part.thought) {
        yield { type: "thinking_delta", text: part.text };
      } else if (part.text) {
        yield { type: "text_delta", text: part.text };
      }
      if (part.thoughtSignature) {
        yield { type: "thinking_signature", signature: part.thoughtSignature };
      }
    }

    if (candidate?.finishReason) {
      stopReason = FINISH_REASON[candidate.finishReason] ?? "end_turn";
    }
  }

  if (sawFunctionCall) stopReason = "tool_use";
  yield { type: "message_stop", stopReason, usage };
}

export const googleAdapter: ProviderAdapter = {
  family: "google",
  stream: streamRaw,
};
