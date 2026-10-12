import { describe, expect, test } from "bun:test";
import type { HttpClient } from "@agency/net";
import { type AgencyError, ErrorCode } from "@agency/schema";
import { createOpenAiCompatibleAdapter } from "../../src/adapters/openai-compatible.ts";
import type { ProviderRequest, StreamEvent } from "../../src/types.ts";

const baseRequest: ProviderRequest = {
  model: "llama3.3",
  apiKey: "unused",
  messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
  maxTokens: 256,
};

async function collect(events: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
}

describe("createOpenAiCompatibleAdapter", () => {
  test("targets the configured base URL, so a self-hosted endpoint works the same way", async () => {
    let capturedUrl = "";
    const http: HttpClient = {
      fetch: async (url) => {
        capturedUrl = url;
        return new Response(
          new ReadableStream({
            start(c) {
              c.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
              c.close();
            },
          }),
          { status: 200 },
        );
      },
    };

    const adapter = createOpenAiCompatibleAdapter("ollama", "http://localhost:11434/v1");
    for await (const _ of adapter.stream(baseRequest, http)) {
      // drain
    }

    expect(capturedUrl).toBe("http://localhost:11434/v1/chat/completions");
  });

  test("labels errors with the given family name, not a hardcoded 'openai'", async () => {
    const http: HttpClient = { fetch: async () => new Response("{}", { status: 401 }) };
    const adapter = createOpenAiCompatibleAdapter("groq", "https://api.groq.com/openai/v1");

    const err = await (async () => {
      try {
        for await (const _ of adapter.stream(baseRequest, http)) void 0;
        return undefined;
      } catch (e) {
        return e;
      }
    })();

    expect((err as { source: string }).source).toBe("groq");
  });

  test("a per-request baseUrl overrides the adapter's configured endpoint", async () => {
    let capturedUrl = "";
    const http: HttpClient = {
      fetch: async (url) => {
        capturedUrl = url;
        return new Response(
          new ReadableStream({
            start(c) {
              c.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
              c.close();
            },
          }),
          { status: 200 },
        );
      },
    };

    const adapter = createOpenAiCompatibleAdapter("openai", "https://api.openai.com/v1");
    for await (const _ of adapter.stream({ ...baseRequest, baseUrl: "https://gateway.internal/v1" }, http)) {
      // drain
    }

    expect(capturedUrl).toBe("https://gateway.internal/v1/chat/completions");
  });

  test("per-request headers merge over the adapter's own, which keep auth", async () => {
    let capturedHeaders: Record<string, unknown> = {};
    const http: HttpClient = {
      fetch: async (_url, init) => {
        capturedHeaders = init?.headers as Record<string, unknown>;
        return new Response(
          new ReadableStream({
            start(c) {
              c.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
              c.close();
            },
          }),
          { status: 200 },
        );
      },
    };

    const adapter = createOpenAiCompatibleAdapter("openai", "https://api.openai.com/v1");
    for await (const _ of adapter.stream(
      { ...baseRequest, headers: { "x-team": "core", authorization: "Bearer override" } },
      http,
    )) {
      // drain
    }

    expect(capturedHeaders["content-type"]).toBe("application/json");
    expect(capturedHeaders["x-team"]).toBe("core");
    expect(capturedHeaders.authorization).toBe("Bearer override");
  });

  test("maps context-length failures to CONTEXT_OVERFLOW by code, status, and message phrasing", async () => {
    const adapter = createOpenAiCompatibleAdapter("openai", "https://api.openai.com/v1");

    const byCode = await collect(
      adapter.stream(
        baseRequest,
        fakeError({ status: 400, body: { error: { code: "context_length_exceeded", message: "nope" } } }),
      ),
    ).catch((e) => e);
    expect((byCode as AgencyError).code).toBe(ErrorCode.CONTEXT_OVERFLOW);

    const byStatus = await collect(
      adapter.stream(baseRequest, fakeError({ status: 413, body: { error: { message: "payload" } } })),
    ).catch((e) => e);
    expect((byStatus as AgencyError).code).toBe(ErrorCode.CONTEXT_OVERFLOW);

    const byMessage = await collect(
      adapter.stream(
        baseRequest,
        fakeError({
          status: 400,
          body: { error: { message: "This model's maximum context length is 8192 tokens" } },
        }),
      ),
    ).catch((e) => e);
    expect((byMessage as AgencyError).code).toBe(ErrorCode.CONTEXT_OVERFLOW);
  });

  test("maps the overflow error of a llama.cpp server to CONTEXT_OVERFLOW", async () => {
    // The body is a capture from llama-server b11155: the code is a number and the message has its own wording.
    const body = {
      error: {
        code: 400,
        message:
          "request (14030 tokens) exceeds the available context size (12288 tokens), try increasing it",
        type: "exceed_context_size_error",
        n_prompt_tokens: 14030,
        n_ctx: 12288,
      },
    };
    const adapter = createOpenAiCompatibleAdapter("local", "http://127.0.0.1:8080/v1");

    const err = await collect(adapter.stream(baseRequest, fakeError({ status: 400, body }))).catch((e) => e);
    expect((err as AgencyError).code).toBe(ErrorCode.CONTEXT_OVERFLOW);
  });

  test("maps content_filter finish reasons to refusal instead of end_turn", async () => {
    const adapter = createOpenAiCompatibleAdapter("openai", "https://api.openai.com/v1");
    const encoder = new TextEncoder();
    const http: HttpClient = {
      fetch: async () =>
        new Response(
          new ReadableStream({
            start(c) {
              c.enqueue(
                encoder.encode('data: {"choices":[{"delta":{},"finish_reason":"content_filter"}]}\n\n'),
              );
              c.enqueue(encoder.encode("data: [DONE]\n\n"));
              c.close();
            },
          }),
          { status: 200 },
        ),
    };

    const events = await collect(adapter.stream(baseRequest, http));
    expect(events.at(-1)).toMatchObject({ type: "message_stop", stopReason: "refusal" });
  });

  test("parses legacy delta.function_call into tool call events", async () => {
    const adapter = createOpenAiCompatibleAdapter("openai", "https://api.openai.com/v1");
    const encoder = new TextEncoder();
    const http: HttpClient = {
      fetch: async () =>
        new Response(
          new ReadableStream({
            start(c) {
              // First delta: function name
              const frame1 = JSON.stringify({
                choices: [
                  { delta: { function_call: { name: "read_file", arguments: "" } }, finish_reason: null },
                ],
              });
              c.enqueue(encoder.encode(`data: ${frame1}\n\n`));
              // Second delta: arguments
              const frame2 = JSON.stringify({
                choices: [
                  {
                    delta: { function_call: { arguments: JSON.stringify({ path: "src/index.ts" }) } },
                    finish_reason: null,
                  },
                ],
              });
              c.enqueue(encoder.encode(`data: ${frame2}\n\n`));
              // Finish
              const frame3 = JSON.stringify({
                choices: [{ delta: {}, finish_reason: "function_call" }],
              });
              c.enqueue(encoder.encode(`data: ${frame3}\n\n`));
              c.enqueue(encoder.encode("data: [DONE]\n\n"));
              c.close();
            },
          }),
          { status: 200 },
        ),
    };

    const events = await collect(adapter.stream(baseRequest, http));

    const starts = events.filter((e) => e.type === "tool_call_start");
    expect(starts).toHaveLength(1);
    expect(starts[0]).toMatchObject({ type: "tool_call_start", name: "read_file" });
    expect((starts[0] as { id: string }).id).toBeTruthy();

    const deltas = events.filter((e) => e.type === "tool_call_delta");
    expect(deltas).toHaveLength(1);

    const ends = events.filter((e) => e.type === "tool_call_end");
    expect(ends).toHaveLength(1);

    const stop = events.find((e) => e.type === "message_stop") as { stopReason: string };
    expect(stop.stopReason).toBe("tool_use");
  });

  /** A stream of chat completion chunks, one per delta, the last one with the finish reason. */
  function streamOf(deltas: unknown[], finishReason: string | null): HttpClient {
    const frames = deltas.map((delta, i) => ({
      choices: [{ delta, finish_reason: i === deltas.length - 1 ? finishReason : null }],
    }));
    const text = `${frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join("")}data: [DONE]\n\n`;
    return { fetch: async () => new Response(text, { status: 200 }) };
  }

  test("a tool call that ends with finish reason stop is still a tool turn", async () => {
    // Some servers send the call and then "stop". With end_turn the loop would not run the tool.
    const http = streamOf(
      [{ tool_calls: [{ index: 0, id: "call_1", function: { name: "read", arguments: '{"path":"a"}' } }] }],
      "stop",
    );
    const adapter = createOpenAiCompatibleAdapter("ollama", "http://localhost:11434/v1");

    const events = await collect(adapter.stream(baseRequest, http));
    expect(events.at(-1)).toMatchObject({ type: "message_stop", stopReason: "tool_use" });
  });

  test("a stream that ends with no finish reason still closes its open tool call", async () => {
    const http = streamOf(
      [{ tool_calls: [{ index: 0, id: "call_1", function: { name: "read", arguments: '{"path":"a"}' } }] }],
      null,
    );
    const adapter = createOpenAiCompatibleAdapter("gateway", "http://localhost/v1");

    const events = await collect(adapter.stream(baseRequest, http));
    expect(events.map((event) => event.type)).toEqual([
      "tool_call_start",
      "tool_call_delta",
      "tool_call_end",
      "message_stop",
    ]);
    expect(events.at(-1)).toMatchObject({ stopReason: "tool_use" });
  });

  test("an OpenRouter stream repeats the finish reason on its usage chunk: the tool call ends once", async () => {
    // Recorded from openrouter.ai with deepseek/deepseek-v4-flash. Two ends made the loop run each tool twice.
    const cassette = await Bun.file(`${import.meta.dir}/../cassettes/openrouter-stream-tool-call.sse`).text();
    const http: HttpClient = { fetch: async () => new Response(cassette, { status: 200 }) };
    const adapter = createOpenAiCompatibleAdapter("openrouter", "https://openrouter.ai/api/v1");

    const events = await collect(adapter.stream(baseRequest, http));
    expect(events.filter((event) => event.type === "tool_call_end")).toEqual([
      { type: "tool_call_end", id: "call_c167c9cf19a14a05b9cf6eba" },
    ]);
    expect(events.at(-1)).toMatchObject({
      type: "message_stop",
      stopReason: "tool_use",
      usage: { inputTokens: 359, outputTokens: 63, costUsd: 0.000044135 },
    });
  });

  test("OpenRouter sends reasoning in `delta.reasoning`: it comes out as thinking", async () => {
    const cassette = await Bun.file(`${import.meta.dir}/../cassettes/openrouter-stream-tool-call.sse`).text();
    const http: HttpClient = { fetch: async () => new Response(cassette, { status: 200 }) };
    const adapter = createOpenAiCompatibleAdapter("openrouter", "https://openrouter.ai/api/v1");

    const events = await collect(adapter.stream(baseRequest, http));
    const thinking = events.flatMap((event) => (event.type === "thinking_delta" ? [event.text] : []));
    expect(thinking.join("")).toBe("The user wants me to call the read tool on notes.txt. Let me do that.");
  });

  test("a tool call with no id still runs: the adapter gives it one", async () => {
    const http = streamOf(
      [
        { tool_calls: [{ index: 0, id: "", function: { name: "read", arguments: "" } }] },
        { tool_calls: [{ index: 0, function: { arguments: '{"path":"a"}' } }] },
        {},
      ],
      "tool_calls",
    );
    const adapter = createOpenAiCompatibleAdapter("gateway", "http://localhost/v1");

    const events = await collect(adapter.stream(baseRequest, http));
    const id =
      (events.find((event) => event.type === "tool_call_start") as { id: string } | undefined)?.id ?? "";
    expect(id).toBeTruthy();
    expect(events).toContainEqual({ type: "tool_call_delta", id, inputJsonDelta: '{"path":"a"}' });
    expect(events).toContainEqual({ type: "tool_call_end", id });
  });

  test("reasoning_content of a reasoning model becomes thinking, not a silent drop", async () => {
    // llama-server b11155 with Qwen3 streams its reasoning in this delta field before the answer.
    const http = streamOf([{ reasoning_content: "17 plus 25" }, { content: "42" }], "stop");
    const adapter = createOpenAiCompatibleAdapter("local", "http://127.0.0.1:8080/v1");

    const events = await collect(adapter.stream(baseRequest, http));
    expect(events.slice(0, 2)).toEqual([
      { type: "thinking_delta", text: "17 plus 25" },
      { type: "text_delta", text: "42" },
    ]);
  });

  test("a refusal in the delta's own field is shown as text and ends the turn as a refusal", async () => {
    // The API description gives the stream delta a `refusal` field next to `content`.
    const http = streamOf([{ refusal: "I can't help " }, { refusal: "with that." }], "stop");
    const adapter = createOpenAiCompatibleAdapter("openai", "https://api.openai.com/v1");

    const events = await collect(adapter.stream(baseRequest, http));
    expect(events.slice(0, 2)).toEqual([
      { type: "text_delta", text: "I can't help " },
      { type: "text_delta", text: "with that." },
    ]);
    expect(events.at(-1)).toMatchObject({ type: "message_stop", stopReason: "refusal" });
  });

  function fakeError(options: { status: number; body: unknown }): HttpClient {
    return {
      fetch: async () => new Response(JSON.stringify(options.body), { status: options.status }),
    };
  }
});
