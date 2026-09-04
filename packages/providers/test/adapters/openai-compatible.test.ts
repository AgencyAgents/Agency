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

  function fakeError(options: { status: number; body: unknown }): HttpClient {
    return {
      fetch: async () => new Response(JSON.stringify(options.body), { status: options.status }),
    };
  }
});
