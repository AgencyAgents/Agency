import { describe, expect, test } from "bun:test";
import type { HttpClient } from "@agency/net";
import { anthropicAdapter } from "../../src/adapters/anthropic.ts";
import { createOpenAiCompatibleAdapter } from "../../src/adapters/openai-compatible.ts";
import type { ProviderAdapter, ProviderRequest } from "../../src/types.ts";

const transcript: ProviderRequest["messages"] = [
  { role: "user", content: [{ type: "text", text: "look at shot.png" }] },
  {
    role: "assistant",
    content: [{ type: "tool_call", id: "c1", name: "read", input: { path: "shot.png" } }],
  },
  {
    role: "user",
    content: [
      {
        type: "tool_result",
        toolCallId: "c1",
        content: "Attached image shot.png (image/png, 3 bytes).",
        isError: false,
        images: [{ type: "image", mimeType: "image/png", data: "AAAA" }],
      },
    ],
  },
];

async function sentBody(
  adapter: ProviderAdapter,
  vision: boolean | undefined,
): Promise<Record<string, unknown>> {
  let body = "";
  const http: HttpClient = {
    fetch: async (_url, init) => {
      body = init?.body as string;
      return new Response(new ReadableStream({ start: (c) => c.close() }), { status: 200 });
    },
  };
  const request: ProviderRequest = {
    model: "m",
    apiKey: "k",
    messages: transcript,
    maxTokens: 64,
    ...(vision === undefined ? {} : { vision }),
  };
  for await (const _ of adapter.stream(request, http)) {
    // drain
  }
  return JSON.parse(body) as Record<string, unknown>;
}

describe("images that a tool returned", () => {
  test("anthropic: a vision model gets the image inside the tool result", async () => {
    const messages = (await sentBody(anthropicAdapter, true)).messages as Array<{ content: unknown[] }>;
    expect(messages[2]?.content[0]).toMatchObject({
      type: "tool_result",
      tool_use_id: "c1",
      content: [
        { type: "text", text: "Attached image shot.png (image/png, 3 bytes)." },
        { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } },
      ],
    });
  });

  test("openai-compatible: a vision model gets the image in a user message after the tool messages", async () => {
    const adapter = createOpenAiCompatibleAdapter("openai", "http://localhost/v1");
    const messages = (await sentBody(adapter, true)).messages as Array<Record<string, unknown>>;
    expect(messages.map((message) => message.role)).toEqual(["user", "assistant", "tool", "user"]);
    expect(messages[2]).toMatchObject({
      tool_call_id: "c1",
      content: "Attached image shot.png (image/png, 3 bytes).",
    });
    expect(JSON.stringify(messages[3]?.content)).toContain("data:image/png;base64,AAAA");
  });

  test.each([
    ["anthropic", anthropicAdapter],
    ["openai-compatible", createOpenAiCompatibleAdapter("openai", "http://localhost/v1")],
  ])("%s: a model that is not known to see images gets the text only", async (_name, adapter) => {
    // An image sent to a model with no vision fails that request and every later one.
    expect(JSON.stringify(await sentBody(adapter, undefined))).not.toContain("AAAA");
    expect(JSON.stringify(await sentBody(adapter, false))).not.toContain("AAAA");
  });
});
