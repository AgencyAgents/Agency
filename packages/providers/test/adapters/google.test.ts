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

    const id = (events[1] as { id: string }).id;
    expect(events).toEqual([
      { type: "text_delta", text: "Let me check." },
      { type: "tool_call_start", id, name: "read" },
      { type: "tool_call_delta", id, inputJsonDelta: '{"path":"src/index.ts"}' },
      { type: "tool_call_end", id },
      { type: "message_stop", stopReason: "tool_use", usage: { inputTokens: 300, outputTokens: 20 } },
    ]);
  });

  test("a call keeps the id the model gave it, and an id the adapter makes never repeats", async () => {
    const callChunk = (call: Record<string, unknown>) =>
      `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ functionCall: call }] } }] })}\n\n`;
    const startId = async (call: Record<string, unknown>): Promise<string> => {
      const events = await collect(googleAdapter.stream(baseRequest, fakeHttp(sseResponse(callChunk(call)))));
      return (events.find((event) => event.type === "tool_call_start") as { id: string }).id;
    };

    expect(await startId({ id: "fc-9", name: "read", args: {} })).toBe("fc-9");
    // Two turns of one session: equal ids would be rejected when the session moves to another provider.
    expect(await startId({ name: "read", args: {} })).not.toBe(await startId({ name: "read", args: {} }));
  });

  test("a function response goes back with the call's id, its real name, and the call's signature", async () => {
    let captured = "";
    const http: HttpClient = {
      fetch: async (_url, init) => {
        captured = init?.body as string;
        return sseResponse("");
      },
    };
    await collect(
      googleAdapter.stream(
        {
          ...baseRequest,
          messages: [
            { role: "user", content: [{ type: "text", text: "read it" }] },
            {
              role: "assistant",
              content: [
                { type: "tool_call", id: "fc-1", name: "read", input: { path: "a.ts" } },
                { type: "thinking", text: "", signature: "gsig-1", family: "google" },
                { type: "tool_call", id: "fc-2", name: "read", input: { path: "b.ts" } },
                { type: "thinking", text: "", signature: "from-claude", family: "anthropic" },
              ],
            },
            {
              role: "user",
              content: [
                { type: "tool_result", toolCallId: "fc-1", content: "file text", isError: false },
                { type: "tool_result", toolCallId: "fc-2", content: "other text", isError: false },
              ],
            },
          ],
        },
        http,
      ),
    );

    const contents = JSON.parse(captured).contents as Array<{ role: string; parts: unknown[] }>;
    expect(contents[1]).toEqual({
      role: "model",
      parts: [
        { functionCall: { id: "fc-1", name: "read", args: { path: "a.ts" } }, thoughtSignature: "gsig-1" },
        // A signature from another provider does not go to Gemini.
        { functionCall: { id: "fc-2", name: "read", args: { path: "b.ts" } } },
      ],
    });
    expect(contents[2]).toEqual({
      role: "user",
      parts: [
        { functionResponse: { id: "fc-1", name: "read", response: { content: "file text" } } },
        { functionResponse: { id: "fc-2", name: "read", response: { content: "other text" } } },
      ],
    });
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

  test("maps an oversized-input 400 to CONTEXT_OVERFLOW", async () => {
    const http = fakeHttp(
      new Response(
        JSON.stringify({
          error: {
            message: "The input token count (283165) exceeds the maximum number of tokens allowed (139138).",
            status: "INVALID_ARGUMENT",
          },
        }),
        { status: 400 },
      ),
    );

    const err = await collect(googleAdapter.stream(baseRequest, http)).catch((e) => e);
    expect((err as AgencyError).code).toBe(ErrorCode.CONTEXT_OVERFLOW);
  });

  test("maps SAFETY and MALFORMED_FUNCTION_CALL finish reasons to refusal and error", async () => {
    const chunkFor = (finishReason: string) =>
      sseResponse(
        `data: ${JSON.stringify({
          candidates: [{ content: { parts: [{ text: "..." }] }, finishReason }],
          usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 2 },
        })}\n\n`,
      );

    const safety = await collect(googleAdapter.stream(baseRequest, fakeHttp(chunkFor("SAFETY"))));
    expect(safety.at(-1)).toMatchObject({ type: "message_stop", stopReason: "refusal" });

    const malformed = await collect(
      googleAdapter.stream(baseRequest, fakeHttp(chunkFor("MALFORMED_FUNCTION_CALL"))),
    );
    expect(malformed.at(-1)).toMatchObject({ type: "message_stop", stopReason: "error" });

    const recitation = await collect(googleAdapter.stream(baseRequest, fakeHttp(chunkFor("RECITATION"))));
    expect(recitation.at(-1)).toMatchObject({ type: "message_stop", stopReason: "refusal" });
  });

  test("usage counts the cached prompt part and bills thinking tokens as output", async () => {
    const sse = sseResponse(
      `data: ${JSON.stringify({
        candidates: [{ content: { parts: [{ text: "ok" }] }, finishReason: "STOP" }],
        usageMetadata: {
          promptTokenCount: 300,
          cachedContentTokenCount: 200,
          candidatesTokenCount: 20,
          thoughtsTokenCount: 80,
        },
      })}\n\n`,
    );

    const events = await collect(googleAdapter.stream(baseRequest, fakeHttp(sse)));
    expect(events.at(-1)).toMatchObject({
      type: "message_stop",
      usage: { inputTokens: 300, outputTokens: 100, cachedInputTokens: 200 },
    });
  });

  test("surfaces thought signatures as thinking_signature events", async () => {
    const sse = sseResponse(
      `data: ${JSON.stringify({
        candidates: [
          { content: { parts: [{ text: "thinking hard", thought: true, thoughtSignature: "gsig-1" }] } },
        ],
      })}\n\n`,
    );

    const events = await collect(googleAdapter.stream(baseRequest, fakeHttp(sse)));
    expect(events).toContainEqual({ type: "thinking_delta", text: "thinking hard" });
    expect(events).toContainEqual({ type: "thinking_signature", signature: "gsig-1" });
  });
});
