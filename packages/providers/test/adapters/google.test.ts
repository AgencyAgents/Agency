import { describe, expect, test } from "bun:test";
import type { HttpClient } from "@agency/net";
import { AgencyError, ErrorCode } from "@agency/schema";
import { googleAdapter } from "../../src/adapters/google.ts";
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
  model: "gemini-3-pro",
  apiKey: "key-test",
  messages: [{ role: "user", content: [{ type: "text", text: "read src/index.ts" }] }],
  maxTokens: 1024,
};

async function collect(events: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
}

describe("googleAdapter", () => {
  test("normalizes a text-then-function-call turn, treating STOP+functionCall as tool_use", async () => {
    const cassette = await Bun.file(`${import.meta.dir}/../cassettes/google-stream-tool-call.sse`).text();
    const http = fakeHttp(sseResponse(cassette));

    const events = await collect(googleAdapter.stream(baseRequest, http));

    expect(events).toEqual([
      { type: "text_delta", text: "Let me check." },
      { type: "tool_call_start", id: "call_0", name: "read" },
      { type: "tool_call_delta", id: "call_0", inputJsonDelta: '{"path":"src/index.ts"}' },
      { type: "tool_call_end", id: "call_0" },
      { type: "message_stop", stopReason: "tool_use", usage: { inputTokens: 300, outputTokens: 20 } },
    ]);
  });

  test("maps RESOURCE_EXHAUSTED to a retryable RATE_LIMIT error even on a non-429 status", async () => {
    const http = fakeHttp(
      new Response(JSON.stringify({ error: { message: "quota exceeded", status: "RESOURCE_EXHAUSTED" } }), {
        status: 400,
      }),
    );

    const err = await collect(googleAdapter.stream(baseRequest, http)).catch((e) => e);
    expect(err).toBeInstanceOf(AgencyError);
    expect((err as AgencyError).code).toBe(ErrorCode.RATE_LIMIT);
  });

  test("maps a 401 response to a fatal AUTH error", async () => {
    const http = fakeHttp(new Response(JSON.stringify({ error: { message: "bad key" } }), { status: 401 }));

    const err = await collect(googleAdapter.stream(baseRequest, http)).catch((e) => e);
    expect((err as AgencyError).code).toBe(ErrorCode.AUTH);
  });

  test("maps the unified thinking scale to a Gemini token budget, with max meaning dynamic", async () => {
    let capturedUrl = "";
    let capturedBody: string | undefined;
    const http: HttpClient = {
      fetch: async (url, init) => {
        capturedUrl = url;
        capturedBody = init?.body as string;
        return sseResponse("");
      },
    };

    await collect(googleAdapter.stream({ ...baseRequest, thinkingLevel: "max" }, http));

    expect(capturedUrl).toContain("gemini-3-pro:streamGenerateContent");
    expect(capturedUrl).toContain("alt=sse");
    const body = JSON.parse(capturedBody!);
    expect(body.generationConfig.thinkingConfig).toEqual({ thinkingBudget: -1 });
  });
});
