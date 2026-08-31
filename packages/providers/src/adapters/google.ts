import type { HttpClient } from "@agency/net";
import { AgencyError, type ContentBlock, ErrorCode, type Message, type StopReason } from "@agency/schema";
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

function buildRequestBody(request: ProviderRequest): Record<string, unknown> {
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

  if (request.system) {
    body.systemInstruction = { parts: [{ text: request.system }] };
  }

  if (request.tools?.length) {
    body.tools = [
      {
        functionDeclarations: request.tools.map((t) => ({
          name: t.name,
          description: t.description,
          parameters: t.inputSchema,
        })),
      },
    ];
  }

  return body;
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
    return new AgencyError(ErrorCode.RATE_LIMIT, message, { source: "google", context });
  }
  if (res.status >= 500) {
    return new AgencyError(ErrorCode.TRANSIENT, message, { source: "google", context });
  }
  return new AgencyError(ErrorCode.INTERNAL, message, { source: "google", context });
}

interface GeminiPart {
  text?: string;
  thought?: boolean;
  functionCall?: { name: string; args: Record<string, unknown> };
}

interface GeminiChunk {
  candidates?: Array<{
    content?: { parts?: GeminiPart[] };
    finishReason?: string;
  }>;
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
}

export const googleAdapter: ProviderAdapter = {
  family: "google",

  async *stream(request, http: HttpClient): AsyncIterable<StreamEvent> {
    const url = `${BASE_URL}/${request.model}:streamGenerateContent?alt=sse&key=${request.apiKey}`;
    const res = await http.fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(buildRequestBody(request)),
      signal: request.signal,
    });

    if (!res.ok || !res.body) {
      throw await toAgencyError(res);
    }

    let usage = { inputTokens: 0, outputTokens: 0 };
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
      }

      if (candidate?.finishReason === "MAX_TOKENS") stopReason = "max_tokens";
    }

    if (sawFunctionCall) stopReason = "tool_use";
    yield { type: "message_stop", stopReason, usage };
  },
};
