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

  test("takes the counts and the charge that a gateway reports at the end of the stream", async () => {
    // Recorded from the Messages endpoint of OpenRouter: message_start has zero counts, message_delta has the real ones.
    const cassette = await Bun.file(`${import.meta.dir}/../cassettes/openrouter-messages-stream.sse`).text();
    const events = await collect(anthropicAdapter.stream(baseRequest, fakeHttp(sseResponse(cassette))));

    expect(events.at(-1)).toEqual({
      type: "message_stop",
      stopReason: "end_turn",
      usage: { inputTokens: 21, outputTokens: 33, cachedInputTokens: 0, costUsd: 0.00001218 },
    });
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

  test("a model after the 4.5 family takes adaptive thinking with an effort level, not a budget", async () => {
    // The API documentation: these models answer 400 to a thinking budget, and hide thinking text by default.
    const bodyFor = async (model: string, thinkingLevel: ProviderRequest["thinkingLevel"]) => {
      let captured = "";
      const http: HttpClient = {
        fetch: async (_url, init) => {
          captured = init?.body as string;
          return sseResponse("");
        },
      };
      await collect(anthropicAdapter.stream({ ...baseRequest, model, maxTokens: 8192, thinkingLevel }, http));
      const body = JSON.parse(captured);
      return { thinking: body.thinking, effort: body.output_config?.effort };
    };
    const adaptive = { type: "adaptive", display: "summarized" };

    expect(await bodyFor("claude-opus-5", "high")).toEqual({ thinking: adaptive, effort: "high" });
    expect(await bodyFor("claude-opus-4-7", "minimal")).toEqual({ thinking: adaptive, effort: "low" });
    expect(await bodyFor("claude-fable-5-1", "max")).toEqual({ thinking: adaptive, effort: "max" });
    // The 4.6 models have no xhigh level.
    expect(await bodyFor("claude-sonnet-4-6", "xhigh")).toEqual({ thinking: adaptive, effort: "high" });
    expect(await bodyFor("claude-opus-5", "off")).toEqual({ thinking: undefined, effort: undefined });
    // The 4.5 family and older models answer 400 to adaptive thinking: they keep the budget.
    for (const model of ["claude-sonnet-4-5", "claude-opus-4-5-20251101", "claude-opus-4-20250514"]) {
      expect((await bodyFor(model, "minimal")).thinking).toEqual({ type: "enabled", budget_tokens: 1024 });
    }
  });

  test("maps a unified thinking level to the budget_tokens of a budget model", async () => {
    let capturedBody: string | undefined;
    const http: HttpClient = {
      fetch: async (_url, init) => {
        capturedBody = init?.body as string;
        return sseResponse("");
      },
    };

    await collect(
      anthropicAdapter.stream(
        { ...baseRequest, model: "claude-sonnet-4-5", maxTokens: 32000, thinkingLevel: "high" },
        http,
      ),
    );

    const body = JSON.parse(capturedBody!);
    expect(body.thinking).toEqual({ type: "enabled", budget_tokens: 8192 });
  });

  test("the thinking budget stays inside the limits of the API: at least 1024 and less than max_tokens", async () => {
    const thinkingFor = async (maxTokens: number): Promise<unknown> => {
      let captured = "";
      const http: HttpClient = {
        fetch: async (_url, init) => {
          captured = init?.body as string;
          return sseResponse("");
        },
      };
      await collect(
        anthropicAdapter.stream(
          { ...baseRequest, model: "claude-sonnet-4-5", maxTokens, thinkingLevel: "high" },
          http,
        ),
      );
      return JSON.parse(captured).thinking;
    };

    // 8192 is the default output limit of a model that is not in the catalog, and the budget of "high".
    expect(await thinkingFor(8192)).toEqual({ type: "enabled", budget_tokens: 4096 });
    // No budget of 1024 or more fits: the request goes out with no thinking, not as a sure 400.
    expect(await thinkingFor(1024)).toBeUndefined();
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

  test("maps an oversized-input 400 to CONTEXT_OVERFLOW", async () => {
    const http = fakeHttp(
      new Response(
        JSON.stringify({
          error: {
            type: "invalid_request_error",
            message: "prompt is too long: 246836 tokens > 200000 maximum",
          },
        }),
        { status: 400 },
      ),
    );

    const err = await collect(anthropicAdapter.stream(baseRequest, http)).catch((e) => e);
    expect((err as AgencyError).code).toBe(ErrorCode.CONTEXT_OVERFLOW);
  });

  test("maps the overflow error of a llama.cpp server on the messages endpoint to CONTEXT_OVERFLOW", async () => {
    // The body is a capture from the /v1/messages endpoint of llama-server b11155.
    const body = {
      error: {
        code: 400,
        message:
          "request (13630 tokens) exceeds the available context size (12288 tokens), try increasing it",
        type: "exceed_context_size_error",
        n_prompt_tokens: 13630,
        n_ctx: 12288,
      },
    };
    const http = fakeHttp(new Response(JSON.stringify(body), { status: 400 }));

    const err = await collect(anthropicAdapter.stream(baseRequest, http)).catch((e) => e);
    expect((err as AgencyError).code).toBe(ErrorCode.CONTEXT_OVERFLOW);
  });

  test("a reply that stops because the context window is full is a context overflow, not a normal end", async () => {
    // Claude 4.5 and later accept a request that cannot fit, and stop the reply with this reason.
    const http = fakeHttp(
      sseResponse(
        [
          'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":1}}}\n\n',
          'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"half"}}\n\n',
          'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"model_context_window_exceeded"},"usage":{"output_tokens":5}}\n\n',
          'event: message_stop\ndata: {"type":"message_stop"}\n\n',
        ].join(""),
      ),
    );

    const err = await collect(anthropicAdapter.stream(baseRequest, http)).catch((e) => e);
    expect((err as AgencyError).code).toBe(ErrorCode.CONTEXT_OVERFLOW);
  });

  test("maps a 413 request-too-large response to CONTEXT_OVERFLOW", async () => {
    const http = fakeHttp(
      new Response(JSON.stringify({ error: { type: "request_too_large", message: "request too large" } }), {
        status: 413,
      }),
    );

    const err = await collect(anthropicAdapter.stream(baseRequest, http)).catch((e) => e);
    expect((err as AgencyError).code).toBe(ErrorCode.CONTEXT_OVERFLOW);
  });

  test("maps refusal and pause_turn stop reasons instead of collapsing them to end_turn", async () => {
    const refusal = sseResponse(
      [
        'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":1}}}\n\n',
        'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"refusal"},"usage":{"output_tokens":5}}\n\n',
        'event: message_stop\ndata: {"type":"message_stop"}\n\n',
      ].join(""),
    );
    const events = await collect(anthropicAdapter.stream(baseRequest, fakeHttp(refusal)));
    expect(events.at(-1)).toMatchObject({ type: "message_stop", stopReason: "refusal" });

    const paused = sseResponse(
      [
        'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":1}}}\n\n',
        'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"pause_turn"},"usage":{"output_tokens":5}}\n\n',
        'event: message_stop\ndata: {"type":"message_stop"}\n\n',
      ].join(""),
    );
    const pausedEvents = await collect(anthropicAdapter.stream(baseRequest, fakeHttp(paused)));
    expect(pausedEvents.at(-1)).toMatchObject({ type: "message_stop", stopReason: "end_turn" });
  });

  test("surfaces thinking signatures and redacted_thinking blocks as stream events", async () => {
    const sse = sseResponse(
      [
        'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":1}}}\n\n',
        'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"thinking"}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"hmm"}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"sig-abc"}}\n\n',
        'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
        'event: content_block_start\ndata: {"type":"content_block_start","index":1,"content_block":{"type":"redacted_thinking","data":"enc-payload"}}\n\n',
        'event: content_block_stop\ndata: {"type":"content_block_stop","index":1}\n\n',
        'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":3}}\n\n',
        'event: message_stop\ndata: {"type":"message_stop"}\n\n',
      ].join(""),
    );

    const events = await collect(anthropicAdapter.stream(baseRequest, fakeHttp(sse)));
    expect(events).toContainEqual({ type: "thinking_signature", signature: "sig-abc" });
    expect(events).toContainEqual({ type: "redacted_thinking", data: "enc-payload" });
  });

  test("replays signed thinking and redacted_thinking verbatim, drops unsigned thinking", async () => {
    let capturedBody: string | undefined;
    const http: HttpClient = {
      fetch: async (_url, init) => {
        capturedBody = init?.body as string;
        return sseResponse("");
      },
    };

    await collect(
      anthropicAdapter.stream(
        {
          ...baseRequest,
          messages: [
            {
              role: "assistant",
              content: [
                { type: "thinking", text: "unsigned history" },
                { type: "thinking", text: "signed history", signature: "sig-123" },
                { type: "thinking", text: "", signature: "from-gemini", family: "google" },
                { type: "thinking", text: "own model", signature: "sig-789", family: "anthropic" },
                { type: "redacted_thinking", data: "enc-456" },
                { type: "text", text: "answer" },
              ],
            },
            { role: "user", content: [{ type: "text", text: "next" }] },
          ],
        },
        http,
      ),
    );

    const body = JSON.parse(capturedBody!);
    const assistant = body.messages[0].content;
    expect(assistant).toEqual([
      { type: "thinking", thinking: "signed history", signature: "sig-123" },
      // The block signed by another provider is gone: this API rejects a signature that it did not issue.
      { type: "thinking", thinking: "own model", signature: "sig-789" },
      { type: "redacted_thinking", data: "enc-456" },
      { type: "text", text: "answer" },
    ]);
  });

  test("a message that maps to no content is left out: the API rejects an empty message", async () => {
    let capturedBody = "";
    const http: HttpClient = {
      fetch: async (_url, init) => {
        capturedBody = init?.body as string;
        return sseResponse("");
      },
    };

    await collect(
      anthropicAdapter.stream(
        {
          ...baseRequest,
          messages: [
            { role: "user", content: [{ type: "text", text: "first" }] },
            { role: "assistant", content: [] },
            { role: "assistant", content: [{ type: "thinking", text: "unsigned only" }] },
            { role: "user", content: [{ type: "text", text: "second" }] },
          ],
        },
        http,
      ),
    );

    const messages = JSON.parse(capturedBody).messages as Array<{ role: string; content: unknown[] }>;
    expect(messages.map((message) => message.role)).toEqual(["user", "user"]);
  });

  test("marks tool definitions and the conversation tail as cache breakpoints", async () => {
    let capturedBody: string | undefined;
    const http: HttpClient = {
      fetch: async (_url, init) => {
        capturedBody = init?.body as string;
        return sseResponse("");
      },
    };

    const pad = (s: string): string => s + "x".repeat(4200);
    await collect(
      anthropicAdapter.stream(
        {
          ...baseRequest,
          tools: [
            { name: "read", description: pad("reads"), inputSchema: {} },
            { name: "edit", description: pad("edits"), inputSchema: {} },
          ],
          messages: [
            { role: "user", content: [{ type: "text", text: pad("first") }] },
            { role: "assistant", content: [{ type: "text", text: pad("hi") }] },
            { role: "user", content: [{ type: "text", text: pad("latest question") }] },
          ],
        },
        http,
      ),
    );

    const body = JSON.parse(capturedBody!);
    expect(body.tools.at(-1).cache_control).toEqual({ type: "ephemeral" });
    expect(body.tools[0].cache_control).toBeUndefined();
    const lastUser = body.messages.at(-1).content.at(-1);
    expect(lastUser.cache_control).toEqual({ type: "ephemeral" });
    const settledUser = body.messages.at(0).content.at(-1);
    expect(settledUser.cache_control).toEqual({ type: "ephemeral" });
  });

  test("below-minimum segments emit no cache_control markers", async () => {
    let capturedBody: string | undefined;
    const http: HttpClient = {
      fetch: async (_url, init) => {
        capturedBody = init?.body as string;
        return sseResponse("");
      },
    };

    await collect(
      anthropicAdapter.stream(
        {
          ...baseRequest,
          systemSegments: [
            { stability: "shared", text: "tiny prefix" },
            { stability: "dynamic", text: "tiny env" },
          ],
          tools: [{ name: "read", description: "reads", inputSchema: {} }],
        },
        http,
      ),
    );

    const body = JSON.parse(capturedBody!);
    expect(JSON.stringify(body)).not.toContain("cache_control");
  });

  test("a mid-stream connection drop propagates out of the adapter (core salvages it)", async () => {
    const encoder = new TextEncoder();
    let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
    const http: HttpClient = {
      fetch: async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(c) {
              controller = c;
              c.enqueue(
                encoder.encode(
                  'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":100}}}\n\n',
                ),
              );
              c.enqueue(
                encoder.encode(
                  'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"partial ans"}}\n\n',
                ),
              );
            },
            cancel() {
              // Bun surfaces a cancelled/errored response stream as an iterator throw.
            },
          }),
          { status: 200 },
        ),
    };

    const stream = anthropicAdapter.stream(baseRequest, http);
    const iter = stream[Symbol.asyncIterator]();
    // The adapter swallows message_start internally; the first yielded event is the delta.
    const first = await iter.next();
    expect(first.value).toMatchObject({ type: "text_delta", text: "partial ans" });
    controller!.error(new Error("connection reset"));
    await expect(iter.next()).rejects.toThrow("connection reset");
  });

  test("a connection drop before any content still throws (cheap full retry)", async () => {
    const encoder = new TextEncoder();
    const http: HttpClient = {
      fetch: async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(c) {
              c.enqueue(encoder.encode("event: message_start\n"));
              c.error(new Error("connection reset"));
            },
          }),
          { status: 200 },
        ),
    };

    await expect(collect(anthropicAdapter.stream(baseRequest, http))).rejects.toThrow("connection reset");
  });
});
