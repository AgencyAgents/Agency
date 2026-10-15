import { describe, expect, test } from "bun:test";
import type { HttpClient } from "@agency/net";
import { anthropicAdapter } from "../../src/adapters/anthropic.ts";
import { createOpenAiCompatibleAdapter } from "../../src/adapters/openai-compatible.ts";
import { toResponsesInput } from "../../src/adapters/openai-responses.ts";
import type { ProviderAdapter, ProviderRequest } from "../../src/types.ts";

const transcript: ProviderRequest["messages"] = [
  { role: "user", content: [{ type: "text", text: "sum up report.pdf" }] },
  {
    role: "assistant",
    content: [{ type: "tool_call", id: "c1", name: "read", input: { path: "report.pdf" } }],
  },
  {
    role: "user",
    content: [
      {
        type: "tool_result",
        toolCallId: "c1",
        content: "Attached report.pdf (application/pdf, 3 bytes).",
        isError: false,
        images: [{ type: "image", mimeType: "application/pdf", data: "JVBE" }],
      },
    ],
  },
];

async function sentBody(adapter: ProviderAdapter): Promise<Record<string, unknown>> {
  let body = "";
  const http: HttpClient = {
    fetch: async (_url, init) => {
      body = init?.body as string;
      return new Response(new ReadableStream({ start: (c) => c.close() }), { status: 200 });
    },
  };
  for await (const _ of adapter.stream(
    { model: "m", apiKey: "k", messages: transcript, maxTokens: 64 },
    http,
  )) {
    // drain
  }
  return JSON.parse(body) as Record<string, unknown>;
}

describe("PDFs that a tool returned reach a model with no vision", () => {
  test("openrouter: a file part after the tool messages, parsed by the free engine", async () => {
    const body = await sentBody(createOpenAiCompatibleAdapter("openrouter", "http://localhost/v1"));
    const messages = body.messages as Array<Record<string, unknown>>;
    expect(messages.map((message) => message.role)).toEqual(["user", "assistant", "tool", "user"]);
    expect(messages[3]?.content).toContainEqual({
      type: "file",
      file: { filename: "document.pdf", file_data: "data:application/pdf;base64,JVBE" },
    });
    expect(body.plugins).toEqual([{ id: "file-parser", pdf: { engine: "cloudflare-ai" } }]);
  });

  test("another OpenAI-shaped endpoint: no file part, and the model is told the PDF was left out", async () => {
    const body = await sentBody(createOpenAiCompatibleAdapter("groq", "http://localhost/v1"));
    expect(JSON.stringify(body)).not.toContain("JVBE");
    expect(JSON.stringify(body)).toContain("takes no PDF");
    expect(body.plugins).toBeUndefined();
  });

  test("anthropic: a document block inside the tool result", async () => {
    const messages = (await sentBody(anthropicAdapter)).messages as Array<{ content: unknown[] }>;
    expect(messages[2]?.content[0]).toMatchObject({
      type: "tool_result",
      content: [
        { type: "text", text: "Attached report.pdf (application/pdf, 3 bytes)." },
        { type: "document", source: { type: "base64", media_type: "application/pdf", data: "JVBE" } },
      ],
    });
  });

  test("responses: an input file after the call output", () => {
    const items = toResponsesInput(transcript, "openai", false);
    expect(JSON.stringify(items.at(-1))).toContain(
      JSON.stringify({
        type: "input_file",
        filename: "document.pdf",
        file_data: "data:application/pdf;base64,JVBE",
      }),
    );
  });
});
