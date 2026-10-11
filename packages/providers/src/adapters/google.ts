import type { HttpClient } from "@agency/net";
import { AgencyError, ErrorCode, type Message, type StopReason } from "@agency/schema";
import {
  isCacheable,
  MIN_CACHEABLE_TOKENS,
  SHARED_PREFIX_TTL_SECONDS,
  splitStableDynamic,
} from "../cache-policy.ts";
import { parseRetryAfterMs } from "../retry-after.ts";
import { parseSse } from "../sse.ts";
import type { ProviderAdapter, ProviderRequest, StreamEvent, ThinkingLevel } from "../types.ts";

const BASE_URL = "https://generativelanguage.googleapis.com/v1beta";

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

function thinkingConfig(model: string, level: ThinkingLevel): Record<string, unknown> {
  if (level !== "off") return { thinkingBudget: THINKING_BUDGET[level], includeThoughts: true };
  // 2.5 Pro cannot turn thinking off: 128 is its lowest budget and 0 is an error.
  return { thinkingBudget: model.includes("gemini-2.5-pro") ? 128 : THINKING_BUDGET.off };
}

/** The key goes in a header: an address is shown in errors and logs. */
function authHeaders(request: ProviderRequest): Record<string, string> {
  return { "content-type": "application/json", "x-goog-api-key": request.apiKey, ...request.headers };
}

/**
 * Gemini pairs a response with its call by id and by function name: a response under any other
 * name makes the model return an empty reply. A signature goes back on the part that it arrived with.
 */
function toGeminiContents(messages: Message[]): Record<string, unknown>[] {
  const nameOfCall = new Map<string, string>();
  return messages
    .filter((m) => m.role !== "system")
    .map((m) => {
      const parts: Record<string, unknown>[] = [];
      for (const block of m.content) {
        switch (block.type) {
          case "text":
            parts.push({ text: block.text });
            break;
          case "image":
            parts.push({ inlineData: { mimeType: block.mimeType, data: block.data } });
            break;
          case "tool_call":
            nameOfCall.set(block.id, block.name);
            parts.push({ functionCall: { id: block.id, name: block.name, args: block.input } });
            break;
          case "tool_result":
            parts.push({
              functionResponse: {
                id: block.toolCallId,
                name: nameOfCall.get(block.toolCallId) ?? block.toolCallId,
                response: { content: block.content },
              },
            });
            break;
          case "thinking": {
            // The stream puts a signature right after its part, as a thinking block with no text.
            const signed = parts.at(-1);
            const own = block.signature !== undefined && (block.family ?? "google") === "google";
            if (block.text === "" && own && signed && !signed.thoughtSignature) {
              signed.thoughtSignature = block.signature;
            }
            break;
          }
          case "redacted_thinking":
            break;
        }
      }
      return { role: m.role === "assistant" ? "model" : "user", parts };
    })
    .filter((content) => content.parts.length > 0);
}

/** The fields of the schema subset that `parameters` takes. */
const SUBSET_FIELDS = new Set(
  (
    "type format title description nullable enum items properties required anyOf propertyOrdering default example " +
    "minItems maxItems minProperties maxProperties minLength maxLength pattern minimum maximum"
  ).split(" "),
);

/** `parameters` rejects a keyword outside its subset, a list of types, a node with no type and `anyOf` beside other fields. */
function fitsSubset(node: unknown): boolean {
  if (typeof node !== "object" || node === null || Array.isArray(node)) return false;
  const schema = node as Record<string, unknown>;
  const keys = Object.keys(schema);
  if (!keys.every((key) => SUBSET_FIELDS.has(key))) return false;
  if (Array.isArray(schema.anyOf)) return keys.length === 1 && schema.anyOf.every(fitsSubset);
  if (typeof schema.type !== "string") return false;
  if (schema.items !== undefined && !fitsSubset(schema.items)) return false;
  return Object.values((schema.properties ?? {}) as Record<string, unknown>).every(fitsSubset);
}

function toGeminiTools(request: ProviderRequest): Record<string, unknown>[] | undefined {
  if (!request.tools?.length) return undefined;
  return [
    {
      // One schema that `parameters` rejects fails the whole request, so such a schema (an MCP server's, a plugin's)
      // goes in the field that takes full JSON Schema.
      functionDeclarations: request.tools.map((t) => ({
        name: t.name,
        description: t.description,
        ...(fitsSubset(t.inputSchema)
          ? { parameters: t.inputSchema }
          : { parametersJsonSchema: t.inputSchema }),
      })),
    },
  ];
}

function buildRequestBody(
  request: ProviderRequest,
  opts: { cachedContent?: string; systemText?: string } = {},
): Record<string, unknown> {
  const contents = toGeminiContents(request.messages);
  const body: Record<string, unknown> = {
    contents,
    generationConfig: {
      maxOutputTokens: request.maxTokens,
      ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
      ...(request.thinkingLevel
        ? { thinkingConfig: thinkingConfig(request.model, request.thinkingLevel) }
        : {}),
    },
  };

  if (opts.cachedContent) {
    // The API rejects systemInstruction or tools next to cachedContent: the cache holds them.
    // The dynamic part of the prompt leads the contents.
    body.cachedContent = opts.cachedContent;
    if (opts.systemText) {
      const first = contents[0];
      if (first?.role === "user") (first.parts as unknown[]).unshift({ text: opts.systemText });
      else contents.unshift({ role: "user", parts: [{ text: opts.systemText }] });
    }
    return body;
  }

  if (request.system) {
    body.systemInstruction = { parts: [{ text: request.system }] };
  }

  const tools = toGeminiTools(request);
  if (tools) body.tools = tools;

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
    const res = await http.fetch(`${request.baseUrl ?? BASE_URL}/cachedContents`, {
      method: "POST",
      headers: authHeaders(request),
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
  // The reply reached the per-request limit and is not complete: the loop continues a cut reply.
  CONTINUATION: "max_tokens",
  SAFETY: "refusal",
  RECITATION: "refusal",
  BLOCKLIST: "refusal",
  PROHIBITED_CONTENT: "refusal",
  SPII: "refusal",
  LANGUAGE: "refusal",
  IMAGE_SAFETY: "refusal",
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
  functionCall?: { id?: string; name: string; args: Record<string, unknown> };
}

interface GeminiChunk {
  candidates?: Array<{
    content?: { parts?: GeminiPart[] };
    finishReason?: string;
  }>;
  promptFeedback?: { blockReason?: string };
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    cachedContentTokenCount?: number;
    thoughtsTokenCount?: number;
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
  const url = `${request.baseUrl ?? BASE_URL}/models/${request.model}:streamGenerateContent?alt=sse`;
  const res = await http.fetch(url, {
    method: "POST",
    headers: authHeaders(request),
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

  for await (const frame of parseSse(res.body)) {
    const chunk = JSON.parse(frame.data) as GeminiChunk;
    const candidate = chunk.candidates?.[0];
    // A blocked prompt comes back with no candidate.
    if (chunk.promptFeedback?.blockReason) stopReason = "refusal";

    if (chunk.usageMetadata) {
      usage = {
        inputTokens: chunk.usageMetadata.promptTokenCount ?? 0,
        // Thinking tokens are billed as output and are not in the candidates count.
        outputTokens:
          (chunk.usageMetadata.candidatesTokenCount ?? 0) + (chunk.usageMetadata.thoughtsTokenCount ?? 0),
        ...(chunk.usageMetadata.cachedContentTokenCount !== undefined
          ? { cachedInputTokens: chunk.usageMetadata.cachedContentTokenCount }
          : {}),
      };
    }

    for (const part of candidate?.content?.parts ?? []) {
      if (part.functionCall) {
        sawFunctionCall = true;
        // Gemini sends the whole call in one shot: there's no incremental
        // arguments stream the way Anthropic/OpenAI have, so start/delta/end
        // collapse into one immediate sequence per call.
        // A made-up id is unique: ids that repeat across turns are rejected by other providers.
        const id = part.functionCall.id ?? `call_${crypto.randomUUID()}`;
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
      // Only STOP is a normal end: any other reason, also one that the API adds later, left the reply incomplete.
      stopReason = FINISH_REASON[candidate.finishReason] ?? "error";
    }
  }

  if (sawFunctionCall) stopReason = "tool_use";
  yield { type: "message_stop", stopReason, usage };
}

export const googleAdapter: ProviderAdapter = {
  family: "google",
  stream: streamRaw,
};
