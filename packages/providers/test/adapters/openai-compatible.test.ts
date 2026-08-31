import { describe, expect, test } from "bun:test";
import type { HttpClient } from "@agency/net";
import { createOpenAiCompatibleAdapter } from "../../src/adapters/openai-compatible.ts";
import type { ProviderRequest } from "../../src/types.ts";

const baseRequest: ProviderRequest = {
  model: "llama3.3",
  apiKey: "unused",
  messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
  maxTokens: 256,
};

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
});
