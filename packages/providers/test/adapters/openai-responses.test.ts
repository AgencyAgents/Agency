import { describe, expect, test } from "bun:test";
import type { HttpClient } from "@agency/net";
import { AgencyError, ErrorCode } from "@agency/schema";
import { createResponsesAdapter } from "../../src/adapters/openai-responses.ts";
import type { ProviderRequest, StreamEvent } from "../../src/types.ts";

const sse = (events: Record<string, unknown>[]): string =>
  events.map((e) => `event: ${String(e.type)}\ndata: ${JSON.stringify(e)}\n\n`).join("");

function http(reply: Response): {
  client: HttpClient;
  sent: { url: string; body: Record<string, unknown> }[];
} {
  const sent: { url: string; body: Record<string, unknown> }[] = [];
  return {
    sent,
    client: {
      async fetch(url, init) {
        sent.push({ url, body: JSON.parse(String(init?.body)) });
        return reply;
      },
    },
  };
}

async function collect(events: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
}

const adapter = createResponsesAdapter("chatgpt", "https://api.openai.com/v1");
const request: ProviderRequest = {
  model: "gpt-5.5",
  apiKey: "token",
  system: "be brief",
  maxTokens: 8192,
  temperature: 0.2,
  thinkingLevel: "high",
  tools: [{ name: "read", description: "Reads a file.", inputSchema: { type: "object" } }],
  messages: [
    { role: "user", content: [{ type: "text", text: "read a.ts" }] },
    {
      role: "assistant",
      content: [
        { type: "thinking", text: "look first", signature: "enc-1", family: "chatgpt" },
        { type: "thinking", text: "other provider", signature: "sig-x", family: "anthropic" },
        { type: "text", text: "Reading." },
        { type: "tool_call", id: "call_1", name: "read", input: { path: "a.ts" } },
      ],
    },
    {
      role: "user",
      content: [{ type: "tool_result", toolCallId: "call_1", content: "export {}", isError: false }],
    },
  ],
};

describe("Responses adapter for the ChatGPT plan", () => {
  test("the body has instructions, namespaced tools, store false, stream true, and none of the refused fields", async () => {
    const { client, sent } = http(new Response(sse([{ type: "response.completed", response: {} }])));
    await collect(adapter.stream(request, client));
    const [{ url, body } = { url: "", body: {} }] = sent;
    expect(url).toBe("https://api.openai.com/v1/responses");
    expect(body).toMatchObject({ model: "gpt-5.5", instructions: "be brief", store: false, stream: true });
    expect(body.reasoning).toEqual({ effort: "high", summary: "auto" });
    expect(body.include).toEqual(["reasoning.encrypted_content"]);
    for (const refused of [
      "max_output_tokens",
      "temperature",
      "previous_response_id",
      "top_p",
      "metadata",
      "user",
    ]) {
      expect(body).not.toHaveProperty(refused);
    }
    expect(body.tools).toEqual([
      {
        type: "namespace",
        name: "agency",
        description: "The tools of this agent.",
        tools: [
          { type: "function", name: "read", description: "Reads a file.", parameters: { type: "object" } },
        ],
      },
    ]);
    // No system item, and the reasoning of another provider does not go back.
    expect(body.input).toEqual([
      { type: "message", role: "user", content: [{ type: "input_text", text: "read a.ts" }] },
      {
        type: "reasoning",
        summary: [{ type: "summary_text", text: "look first" }],
        encrypted_content: "enc-1",
      },
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "Reading." }] },
      {
        type: "function_call",
        call_id: "call_1",
        name: "read",
        namespace: "agency",
        arguments: '{"path":"a.ts"}',
      },
      { type: "function_call_output", call_id: "call_1", output: "export {}" },
    ]);
  });

  test("a stream gives text, reasoning with its encrypted content, a namespaced call, and usage at no cost", async () => {
    const { client } = http(
      new Response(
        sse([
          { type: "response.reasoning_summary_text.delta", delta: "thinking" },
          { type: "response.output_item.done", item: { type: "reasoning", encrypted_content: "enc-2" } },
          { type: "response.output_text.delta", delta: "Hi" },
          {
            type: "response.output_item.added",
            item: {
              id: "fc_1",
              type: "function_call",
              call_id: "call_9",
              name: "agency.read",
              arguments: "",
            },
          },
          { type: "response.function_call_arguments.delta", item_id: "fc_1", delta: '{"path":' },
          { type: "response.function_call_arguments.delta", item_id: "fc_1", delta: '"b.ts"}' },
          {
            type: "response.output_item.done",
            item: { type: "function_call", call_id: "call_9", arguments: "x" },
          },
          {
            type: "response.completed",
            response: {
              usage: { input_tokens: 100, output_tokens: 20, input_tokens_details: { cached_tokens: 64 } },
            },
          },
        ]),
      ),
    );
    expect(await collect(adapter.stream(request, client))).toEqual([
      { type: "thinking_delta", text: "thinking" },
      { type: "thinking_signature", signature: "enc-2" },
      { type: "text_delta", text: "Hi" },
      { type: "tool_call_start", id: "call_9", name: "read" },
      { type: "tool_call_delta", id: "call_9", inputJsonDelta: '{"path":' },
      { type: "tool_call_delta", id: "call_9", inputJsonDelta: '"b.ts"}' },
      { type: "tool_call_end", id: "call_9" },
      {
        type: "message_stop",
        stopReason: "tool_use",
        usage: { inputTokens: 100, outputTokens: 20, cachedInputTokens: 64, costUsd: 0 },
      },
    ]);
  });

  test("the plan's usage limit is a final error with the settings link; a cut response ends at max_tokens", async () => {
    const limited = http(
      Response.json(
        { error: { code: "subscription_sharing_usage_limit_exceeded", message: "limit" } },
        { status: 429 },
      ),
    );
    const error = await collect(adapter.stream(request, limited.client)).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AgencyError);
    expect((error as AgencyError).code).toBe(ErrorCode.PERMISSION_DENIED);
    expect((error as AgencyError).message).toContain("https://chatgpt.com/settings/usage");

    const failed = http(
      new Response(
        sse([
          {
            type: "response.failed",
            response: { error: { code: "subscription_sharing_usage_unavailable" } },
          },
        ]),
      ),
    );
    const transient = await collect(adapter.stream(request, failed.client)).catch((e: unknown) => e);
    expect((transient as AgencyError).code).toBe(ErrorCode.TRANSIENT);

    const cut = http(
      new Response(
        sse([
          { type: "response.incomplete", response: { incomplete_details: { reason: "max_output_tokens" } } },
        ]),
      ),
    );
    expect((await collect(adapter.stream(request, cut.client))).at(-1)).toMatchObject({
      stopReason: "max_tokens",
    });
  });
});
