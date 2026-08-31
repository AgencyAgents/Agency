import { AgencyError, ErrorCode, type ContentBlock, type Message, type StopReason } from "@agency/schema";
import type { HttpClient } from "@agency/net";
import { parseSse } from "../sse.ts";
import type { ProviderAdapter, ProviderRequest, StreamEvent, ThinkingLevel } from "../types.ts";

/**
 * OpenAI's reasoning_effort only has four tiers, coarser than Agency's unified
 * seven-level scale. The extra levels compress onto the nearest tier rather
 * than erroring — losing precision here is better than refusing to run.
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
  length: "max_tokens",
};

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

    out.push({ role: m.role, content: textOf(m.content) });
  }

  return out;
}

function buildRequestBody(request: ProviderRequest): Record<string, unknown> {
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
    return new AgencyError(ErrorCode.RATE_LIMIT, message, { source: family, context });
  }
  if (body?.error?.code === "context_length_exceeded") {
    return new AgencyError(ErrorCode.CONTEXT_OVERFLOW, message, { source: family, context });
  }
  if (res.status >= 500) {
    return new AgencyError(ErrorCode.TRANSIENT, message, { source: family, context });
  }
  return new AgencyError(ErrorCode.INTERNAL, message, { source: family, context });
}

export function createOpenAiCompatibleAdapter(family: string, baseUrl: string): ProviderAdapter {
  return {
    family,

    async *stream(request, http: HttpClient): AsyncIterable<StreamEvent> {
      const res = await http.fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${request.apiKey}`,
        },
        body: JSON.stringify(buildRequestBody(request)),
        signal: request.signal,
      });

      if (!res.ok || !res.body) {
        throw await toAgencyError(res, family);
      }

      // OpenAI addresses parallel tool calls by delta index, not id — the id only
      // appears once, on the first delta for that index.
      const toolCallIdByIndex = new Map<number, string>();
      let usage = { inputTokens: 0, outputTokens: 0 };
      let stopReason: StopReason = "end_turn";

      for await (const frame of parseSse(res.body)) {
        if (frame.data === "[DONE]") continue;
        const payload = JSON.parse(frame.data) as {
          choices: Array<{
            delta: { content?: string; tool_calls?: Array<{ index: number; id?: string; function?: { name?: string; arguments?: string } }> };
            finish_reason: string | null;
          }>;
          usage?: { prompt_tokens: number; completion_tokens: number };
        };

        if (payload.usage) {
          usage = { inputTokens: payload.usage.prompt_tokens, outputTokens: payload.usage.completion_tokens };
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
    },
  };
}
