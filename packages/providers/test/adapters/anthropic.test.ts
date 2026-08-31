import { describe, expect, test } from "bun:test";
import type { HttpClient } from "@agency/net";
import { AgencyError, ErrorCode } from "@agency/schema";
import { anthropicAdapter } from "../../src/adapters/anthropic.ts";
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
  model: "claude-opus-5",
  apiKey: "sk-test",
  messages: [{ role: "user", content: [{ type: "text", text: "read src/index.ts" }] }],
  maxTokens: 1024,
};

async function collect(events: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
}

describe("anthropicAdapter", () => {
  test("normalizes a full tool-call turn from the recorded SSE cassette", async () => {
    const cassette = await Bun.file(`${import.meta.dir}/../cassettes/anthropic-stream-tool-call.sse`).text();
    const http = fakeHttp(sseResponse(cassette));

    const events = await collect(anthropicAdapter.stream(baseRequest, http));

    expect(events).toEqual([
      { type: "thinking_delta", text: "Checking the file first." },
      { type: "text_delta", text: "Let me read that file." },
      { type: "tool_call_start", id: "toolu_01", name: "read" },
      { type: "tool_call_delta", id: "toolu_01", inputJsonDelta: '{"path":' },
      { type: "tool_call_delta", id: "toolu_01", inputJsonDelta: '"src/index.ts"}' },
      { type: "tool_call_end", id: "toolu_01" },
      {
        type: "message_stop",
        stopReason: "tool_use",
        usage: { inputTokens: 512, outputTokens: 42 },
      },
    ]);
  });

  test("reassembles a streamed tool call's JSON input into a valid object", async () => {
    const cassette = await Bun.file(`${import.meta.dir}/../cassettes/anthropic-stream-tool-call.sse`).text();
    const http = fakeHttp(sseResponse(cassette));

    let assembled = "";
    for await (const event of anthropicAdapter.stream(baseRequest, http)) {
      if (event.type === "tool_call_delta") assembled += event.inputJsonDelta;
    }

    expect(JSON.parse(assembled)).toEqual({ path: "src/index.ts" });
  });

  test("maps a 429 response to a retryable RATE_LIMIT error", async () => {
    const http = fakeHttp(
      new Response(JSON.stringify({ error: { type: "rate_limit_error", message: "slow down" } }), {
        status: 429,
      }),
    );

    const err = await collect(anthropicAdapter.stream(baseRequest, http)).catch((e) => e);
    expect(err).toBeInstanceOf(AgencyError);
    expect((err as AgencyError).code).toBe(ErrorCode.RATE_LIMIT);
    expect((err as AgencyError).isRetryable).toBe(true);
  });

  test("maps a 529 overloaded response to a retryable OVERLOAD error", async () => {
    const http = fakeHttp(
      new Response(JSON.stringify({ error: { type: "overloaded_error", message: "at capacity" } }), {
        status: 529,
      }),
    );

    const err = await collect(anthropicAdapter.stream(baseRequest, http)).catch((e) => e);
    expect((err as AgencyError).code).toBe(ErrorCode.OVERLOAD);
  });

  test("maps a 401 response to a fatal AUTH error", async () => {
    const http = fakeHttp(
      new Response(JSON.stringify({ error: { type: "authentication_error", message: "bad key" } }), {
        status: 401,
      }),
    );

    const err = await collect(anthropicAdapter.stream(baseRequest, http)).catch((e) => e);
    expect((err as AgencyError).code).toBe(ErrorCode.AUTH);
    expect((err as AgencyError).isRetryable).toBe(false);
  });

  test("marks the system prompt as an explicit cache breakpoint", async () => {
    let capturedBody: string | undefined;
    const http: HttpClient = {
      fetch: async (_url, init) => {
        capturedBody = init?.body as string;
        return sseResponse("");
      },
    };

    await collect(anthropicAdapter.stream({ ...baseRequest, system: "You are a coding agent." }, http));

    const body = JSON.parse(capturedBody!);
    expect(body.system).toEqual([
      { type: "text", text: "You are a coding agent.", cache_control: { type: "ephemeral" } },
    ]);
  });

  test("maps a unified thinking level to Anthropic's budget_tokens", async () => {
    let capturedBody: string | undefined;
    const http: HttpClient = {
      fetch: async (_url, init) => {
        capturedBody = init?.body as string;
        return sseResponse("");
      },
    };

    await collect(anthropicAdapter.stream({ ...baseRequest, thinkingLevel: "high" }, http));

    const body = JSON.parse(capturedBody!);
    expect(body.thinking).toEqual({ type: "enabled", budget_tokens: 8192 });
  });

  test("omits the thinking block entirely when the level is off", async () => {
    let capturedBody: string | undefined;
    const http: HttpClient = {
      fetch: async (_url, init) => {
        capturedBody = init?.body as string;
        return sseResponse("");
      },
    };

    await collect(anthropicAdapter.stream({ ...baseRequest, thinkingLevel: "off" }, http));

    const body = JSON.parse(capturedBody!);
    expect(body.thinking).toBeUndefined();
  });
});
