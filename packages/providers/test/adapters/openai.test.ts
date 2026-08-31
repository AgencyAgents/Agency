import { describe, expect, test } from "bun:test";
import type { HttpClient } from "@agency/net";
import { AgencyError, ErrorCode } from "@agency/schema";
import { openaiAdapter } from "../../src/adapters/openai.ts";
import type { ProviderRequest, StreamEvent } from "../../src/types.ts";

function fakeHttp(response: Response): HttpClient {
  return { fetch: async () => response };
}

function sseResponse(text: string, init?: ResponseInit): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(text));
      controller.close();
    },
  });
  return new Response(body, { status: 200, ...init });
}

const baseRequest: ProviderRequest = {
  model: "gpt-5.2",
  apiKey: "sk-test",
  messages: [{ role: "user", content: [{ type: "text", text: "read src/index.ts" }] }],
  maxTokens: 1024,
};

async function collect(events: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
}

describe("openaiAdapter", () => {
  test("normalizes a full tool-call turn from the recorded SSE cassette", async () => {
    const cassette = await Bun.file(`${import.meta.dir}/../cassettes/openai-stream-tool-call.sse`).text();
    const http = fakeHttp(sseResponse(cassette));

    const events = await collect(openaiAdapter.stream(baseRequest, http));

    expect(events).toEqual([
      { type: "text_delta", text: "Let" },
      { type: "text_delta", text: " me check." },
      { type: "tool_call_start", id: "call_1", name: "read" },
      { type: "tool_call_delta", id: "call_1", inputJsonDelta: '{"path":' },
      { type: "tool_call_delta", id: "call_1", inputJsonDelta: '"src/index.ts"}' },
      { type: "tool_call_end", id: "call_1" },
      { type: "message_stop", stopReason: "tool_use", usage: { inputTokens: 400, outputTokens: 30 } },
    ]);
  });

  test("reassembles a streamed tool call's JSON input into a valid object", async () => {
    const cassette = await Bun.file(`${import.meta.dir}/../cassettes/openai-stream-tool-call.sse`).text();
    const http = fakeHttp(sseResponse(cassette));

    let assembled = "";
    for await (const event of openaiAdapter.stream(baseRequest, http)) {
      if (event.type === "tool_call_delta") assembled += event.inputJsonDelta;
    }

    expect(JSON.parse(assembled)).toEqual({ path: "src/index.ts" });
  });

  test("maps a 429 response to a retryable RATE_LIMIT error", async () => {
    const http = fakeHttp(new Response(JSON.stringify({ error: { message: "slow down" } }), { status: 429 }));

    const err = await collect(openaiAdapter.stream(baseRequest, http)).catch((e) => e);
    expect(err).toBeInstanceOf(AgencyError);
    expect((err as AgencyError).code).toBe(ErrorCode.RATE_LIMIT);
  });

  test("maps a context_length_exceeded error code to CONTEXT_OVERFLOW", async () => {
    const http = fakeHttp(
      new Response(
        JSON.stringify({ error: { message: "too long", code: "context_length_exceeded" } }),
        { status: 400 },
      ),
    );

    const err = await collect(openaiAdapter.stream(baseRequest, http)).catch((e) => e);
    expect((err as AgencyError).code).toBe(ErrorCode.CONTEXT_OVERFLOW);
    expect((err as AgencyError).retryClass).toBe("retryable_after_action");
  });

  test("compresses the unified thinking scale onto OpenAI's four reasoning tiers", async () => {
    let capturedBody: string | undefined;
    const http: HttpClient = {
      fetch: async (_url, init) => {
        capturedBody = init?.body as string;
        return sseResponse("data: [DONE]\n\n");
      },
    };

    await collect(openaiAdapter.stream({ ...baseRequest, thinkingLevel: "xhigh" }, http));

    const body = JSON.parse(capturedBody!);
    expect(body.reasoning_effort).toBe("high");
  });
});
