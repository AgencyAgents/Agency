import type { HttpClient } from "@agency/net";
import { AgencyError, type ContentBlock, ErrorCode, type Message, type StopReason } from "@agency/schema";
import { parseSse } from "../sse.ts";
import type { ProviderAdapter, ProviderRequest, StreamEvent, Usage } from "../types.ts";
import { REASONING_EFFORT, toAgencyError } from "./openai-compatible.ts";

/** The plan route takes function tools only inside a namespace. */
const NAMESPACE = "agency";
export const CHATGPT_USAGE_URL = "https://chatgpt.com/settings/usage";

function dataUrl(block: Extract<ContentBlock, { type: "image" }>): string {
  return `data:${block.mimeType};base64,${block.data}`;
}

/** Messages as Responses input items. The model's encrypted reasoning goes back before the calls it led to. */
export function toResponsesInput(
  messages: Message[],
  family: string,
  vision = false,
): Record<string, unknown>[] {
  const items: Record<string, unknown>[] = [];
  for (const m of messages) {
    const parts: Record<string, unknown>[] = [];
    const flush = (): void => {
      if (parts.length > 0) items.push({ type: "message", role: m.role, content: parts.splice(0) });
    };
    const images: Record<string, unknown>[] = [];
    for (const block of m.content) {
      if (block.type === "text") {
        parts.push({ type: m.role === "assistant" ? "output_text" : "input_text", text: block.text });
      } else if (block.type === "image" && m.role !== "assistant") {
        parts.push({ type: "input_image", image_url: dataUrl(block) });
      } else if (block.type === "thinking" && block.signature !== undefined && block.family === family) {
        flush();
        items.push({
          type: "reasoning",
          summary: block.text ? [{ type: "summary_text", text: block.text }] : [],
          encrypted_content: block.signature,
        });
      } else if (block.type === "tool_call") {
        flush();
        items.push({
          type: "function_call",
          call_id: block.id,
          name: block.name,
          namespace: NAMESPACE,
          arguments: JSON.stringify(block.input),
        });
      } else if (block.type === "tool_result") {
        flush();
        items.push({ type: "function_call_output", call_id: block.toolCallId, output: block.content });
        if (vision)
          images.push(
            ...(block.images ?? []).map((image) => ({ type: "input_image", image_url: dataUrl(image) })),
          );
      }
    }
    flush();
    if (images.length > 0) {
      items.push({
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "Images from the tool results above." }, ...images],
      });
    }
  }
  return items;
}

/**
 * The body of the plan route: `store: false` and `stream: true`, instructions in place of a system item, and no
 * `max_output_tokens` or `temperature`, which that route refuses.
 */
export function buildResponsesBody(request: ProviderRequest, family: string): Record<string, unknown> {
  const effort =
    request.thinkingLevel && request.thinkingLevel !== "off"
      ? REASONING_EFFORT[request.thinkingLevel]
      : undefined;
  return {
    model: request.model,
    ...(request.system ? { instructions: request.system } : {}),
    input: toResponsesInput(request.messages, family, request.vision),
    ...(request.tools?.length
      ? {
          tools: [
            {
              type: "namespace",
              name: NAMESPACE,
              description: "The tools of this agent.",
              tools: request.tools.map((t) => ({
                type: "function",
                name: t.name,
                description: t.description,
                parameters: t.inputSchema,
              })),
            },
          ],
        }
      : {}),
    reasoning: { ...(effort ? { effort } : {}), summary: "auto" },
    include: ["reasoning.encrypted_content"],
    store: false,
    stream: true,
  };
}

/** The errors of the plan route that its docs name, as Agency errors; another error as for any OpenAI endpoint. */
async function planError(res: Response, family: string): Promise<AgencyError> {
  const text = await res.text().catch(() => "");
  let error: { code?: string; message?: string; param?: string } | undefined;
  try {
    error = (JSON.parse(text) as { error?: typeof error }).error;
  } catch {}
  const mapped = error?.code ? fromPlanCode(error.code, error.message, error.param, family) : undefined;
  return (
    mapped ?? toAgencyError(new Response(text, { status: res.status, statusText: res.statusText }), family)
  );
}

function fromPlanCode(
  code: string,
  message: string | undefined,
  param: string | undefined,
  family: string,
): AgencyError | undefined {
  const context = { code, ...(param ? { param } : {}) };
  const make = (errorCode: ErrorCode, text: string) =>
    new AgencyError(errorCode, text, { source: family, context });
  switch (code) {
    case "subscription_sharing_usage_limit_exceeded":
      return make(
        ErrorCode.PERMISSION_DENIED,
        `Usage limit reached. Review your plan or this app's limit in ChatGPT settings: ${CHATGPT_USAGE_URL}`,
      );
    case "subscription_sharing_usage_unavailable":
    case "subscription_sharing_user_unavailable":
      return make(ErrorCode.TRANSIENT, `ChatGPT plan usage could not be checked (${code}). Try again later.`);
    case "subscription_sharing_user_not_eligible":
      return make(
        ErrorCode.PERMISSION_DENIED,
        `ChatGPT plan usage is not available for this account (${code}).`,
      );
    case "subscription_sharing_unsupported_capability":
      return make(
        ErrorCode.INVALID_REQUEST,
        `ChatGPT plan usage does not support ${param ?? "a part of this request"}: ${message ?? code}`,
      );
    case "subscription_sharing_invalid_user":
      return make(
        ErrorCode.AUTH,
        `ChatGPT did not accept the sign-in (${code}). Run \`agency auth login chatgpt\`.`,
      );
    default:
      return undefined;
  }
}

interface ResponseItem {
  id?: string;
  type?: string;
  call_id?: string;
  name?: string;
  arguments?: string;
  encrypted_content?: string;
}

async function* streamResponses(
  request: ProviderRequest,
  http: HttpClient,
  family: string,
  baseUrl: string,
): AsyncIterable<StreamEvent> {
  const res = await http.fetch(`${request.baseUrl ?? baseUrl}/responses`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${request.apiKey}`,
      ...request.headers,
    },
    body: JSON.stringify(buildResponsesBody(request, family)),
    signal: request.signal,
  });
  if (!res.ok || !res.body) throw await planError(res, family);

  // Argument deltas name the item; a result names the call.
  const callIdByItem = new Map<string, string>();
  const withDeltas = new Set<string>();
  let usage: Usage = { inputTokens: 0, outputTokens: 0 };
  let stopReason: StopReason = "end_turn";
  let calls = 0;

  for await (const frame of parseSse(res.body)) {
    if (frame.data === "[DONE]") continue;
    const event = JSON.parse(frame.data) as {
      type?: string;
      delta?: string;
      item_id?: string;
      item?: ResponseItem;
      code?: string;
      message?: string;
      response?: {
        error?: { code?: string; message?: string };
        incomplete_details?: { reason?: string };
        usage?: {
          input_tokens?: number;
          output_tokens?: number;
          input_tokens_details?: { cached_tokens?: number };
        };
      };
    };
    switch (event.type) {
      case "response.output_text.delta":
      case "response.refusal.delta":
        if (event.delta) yield { type: "text_delta", text: event.delta };
        if (event.type === "response.refusal.delta") stopReason = "refusal";
        break;
      case "response.reasoning_summary_text.delta":
        if (event.delta) yield { type: "thinking_delta", text: event.delta };
        break;
      case "response.output_item.added":
        if (event.item?.type === "function_call" && event.item.call_id && event.item.name) {
          const name = event.item.name.startsWith(`${NAMESPACE}.`)
            ? event.item.name.slice(NAMESPACE.length + 1)
            : event.item.name;
          callIdByItem.set(event.item.id ?? event.item.call_id, event.item.call_id);
          calls += 1;
          yield { type: "tool_call_start", id: event.item.call_id, name };
        }
        break;
      case "response.function_call_arguments.delta": {
        const id = callIdByItem.get(event.item_id ?? "");
        if (id && event.delta) {
          withDeltas.add(id);
          yield { type: "tool_call_delta", id, inputJsonDelta: event.delta };
        }
        break;
      }
      case "response.output_item.done": {
        const item = event.item;
        if (item?.type === "function_call" && item.call_id) {
          // A call that came whole, with no deltas, still gets its arguments.
          if (!withDeltas.has(item.call_id) && item.arguments) {
            yield { type: "tool_call_delta", id: item.call_id, inputJsonDelta: item.arguments };
          }
          yield { type: "tool_call_end", id: item.call_id };
        } else if (item?.type === "reasoning" && item.encrypted_content) {
          yield { type: "thinking_signature", signature: item.encrypted_content };
        }
        break;
      }
      case "response.completed":
      case "response.incomplete": {
        const u = event.response?.usage;
        usage = {
          inputTokens: u?.input_tokens ?? 0,
          outputTokens: u?.output_tokens ?? 0,
          ...(u?.input_tokens_details?.cached_tokens === undefined
            ? {}
            : { cachedInputTokens: u.input_tokens_details.cached_tokens }),
          // The plan pays: the turn costs the user nothing more.
          costUsd: 0,
        };
        const reason = event.response?.incomplete_details?.reason;
        if (event.type === "response.incomplete")
          stopReason = reason === "content_filter" ? "refusal" : "max_tokens";
        break;
      }
      case "response.failed":
      case "error": {
        const error = event.response?.error ?? { code: event.code, message: event.message };
        throw (
          fromPlanCode(error.code ?? "", error.message, undefined, family) ??
          new AgencyError(ErrorCode.TRANSIENT, error.message ?? error.code ?? "the response failed", {
            source: family,
            context: { code: error.code },
          })
        );
      }
    }
  }
  if (calls > 0 && stopReason === "end_turn") stopReason = "tool_use";
  yield { type: "message_stop", stopReason, usage };
}

/** The Responses API of OpenAI, as the ChatGPT plan route needs it. */
export function createResponsesAdapter(family: string, baseUrl: string): ProviderAdapter {
  return { family, stream: (request, http) => streamResponses(request, http, family, baseUrl) };
}

/** Provider `chatgpt`: the models of a ChatGPT plan, with the sign-in of `agency auth login chatgpt`. */
export const chatgptAdapter = createResponsesAdapter("chatgpt", "https://api.openai.com/v1");
