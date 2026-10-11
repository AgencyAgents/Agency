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

  test("a message that maps to no part is left out of the request", async () => {
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
            { role: "user", content: [{ type: "text", text: "first" }] },
            { role: "assistant", content: [{ type: "thinking", text: "reasoning from another model" }] },
            { role: "user", content: [{ type: "text", text: "second" }] },
          ],
        },
        http,
      ),
    );

    const contents = JSON.parse(captured).contents as Array<{ role: string; parts: unknown[] }>;
    expect(contents.map((content) => content.role)).toEqual(["user", "user"]);
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
    expect(body.generationConfig.thinkingConfig).toEqual({ thinkingBudget: -1, includeThoughts: true });
  });

  const sentBody = async (request: Partial<ProviderRequest>) => {
    let sent: { url: string; headers: Record<string, string>; body: Record<string, unknown> } | undefined;
    const http: HttpClient = {
      fetch: async (url, init) => {
        sent = {
          url,
          headers: init?.headers as Record<string, string>,
          body: JSON.parse(init?.body as string),
        };
        return sseResponse("");
      },
    };
    await collect(googleAdapter.stream({ ...baseRequest, ...request }, http));
    if (!sent) throw new Error("no request was sent");
    return sent;
  };

  test("the key goes in a header, never in the address that errors and logs show", async () => {
    const sent = await sentBody({});
    expect(sent.url).not.toContain("key-test");
    expect(sent.headers["x-goog-api-key"]).toBe("key-test");
  });

  test("asks for thought summaries, and gives 2.5 Pro its lowest budget because it cannot turn thinking off", async () => {
    const thinking = async (request: Partial<ProviderRequest>) =>
      ((await sentBody(request)).body.generationConfig as { thinkingConfig?: unknown }).thinkingConfig;

    expect(await thinking({ thinkingLevel: "high" })).toEqual({
      thinkingBudget: 16384,
      includeThoughts: true,
    });
    expect(await thinking({ thinkingLevel: "off", model: "gemini-2.5-flash" })).toEqual({
      thinkingBudget: 0,
    });
    expect(await thinking({ thinkingLevel: "off", model: "gemini-2.5-pro" })).toEqual({
      thinkingBudget: 128,
    });
    expect(await thinking({})).toBeUndefined();
  });

  test("a tool schema outside Gemini's schema subset goes in parametersJsonSchema, a plain one in parameters", async () => {
    const plain = { type: "object", properties: { path: { type: "string" } }, required: ["path"] };
    const fromMcp = {
      $schema: "http://json-schema.org/draft-07/schema#",
      type: "object",
      properties: { note: { type: ["string", "null"] } },
      additionalProperties: false,
    };
    const union = { type: "object", properties: { id: { anyOf: [{ type: "string" }], description: "x" } } };
    const sent = await sentBody({
      tools: [
        { name: "read", description: "r", inputSchema: plain },
        { name: "mcp_note", description: "n", inputSchema: fromMcp },
        { name: "mcp_union", description: "u", inputSchema: union },
      ],
    });
    expect(sent.body.tools).toEqual([
      {
        functionDeclarations: [
          { name: "read", description: "r", parameters: plain },
          { name: "mcp_note", description: "n", parametersJsonSchema: fromMcp },
          { name: "mcp_union", description: "u", parametersJsonSchema: union },
        ],
      },
    ]);
  });

  test("a blocked prompt is a refusal, and a finish reason that is not a normal stop is an error", async () => {
    const stop = async (chunk: unknown) =>
      (
        await collect(
          googleAdapter.stream(baseRequest, fakeHttp(sseResponse(`data: ${JSON.stringify(chunk)}\n\n`))),
        )
      ).at(-1);

    expect(await stop({ promptFeedback: { blockReason: "PROHIBITED_CONTENT" } })).toMatchObject({
      stopReason: "refusal",
    });
    // CONTINUATION is the API's word for a reply cut at the per-request limit, so the loop continues it.
    const cut = {
      candidates: [{ content: { parts: [{ text: "half an ans" }] }, finishReason: "CONTINUATION" }],
    };
    expect(await stop(cut)).toMatchObject({ stopReason: "max_tokens" });
    for (const finishReason of [
      "MALFORMED_RESPONSE",
      "UNEXPECTED_TOOL_CALL",
      "OTHER",
      "A_REASON_OF_NEXT_YEAR",
    ]) {
      const partial = { candidates: [{ content: { parts: [{ text: "half an ans" }] }, finishReason }] };
      expect(await stop(partial)).toMatchObject({ stopReason: "error" });
    }
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
