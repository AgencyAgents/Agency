import { describe, expect, test } from "bun:test";
import type { HttpClient } from "@agency/net";
import { type AgencyError, ErrorCode } from "@agency/schema";
import { anthropicAdapter } from "../../src/adapters/anthropic.ts";
import { googleAdapter } from "../../src/adapters/google.ts";
import { createOpenAiCompatibleAdapter } from "../../src/adapters/openai-compatible.ts";
import type { ProviderAdapter, ProviderRequest } from "../../src/types.ts";

const request: ProviderRequest = {
  model: "m",
  apiKey: "k",
  messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
  maxTokens: 16,
};

const openrouter = createOpenAiCompatibleAdapter("openrouter", "https://openrouter.ai/api/v1");
const ADAPTERS: ProviderAdapter[] = [anthropicAdapter, googleAdapter, openrouter];

async function failure(adapter: ProviderAdapter, status: number, message: string): Promise<AgencyError> {
  const http: HttpClient = {
    fetch: async () => new Response(JSON.stringify({ error: { message } }), { status }),
  };
  try {
    for await (const _ of adapter.stream(request, http)) void 0;
  } catch (error) {
    return error as AgencyError;
  }
  throw new Error("the stream did not fail");
}

describe("the text and code of a provider's refusal", () => {
  test("a rejected key names the provider, because the provider's own text does not", async () => {
    // "User not found." is the whole 401 message of openrouter.ai.
    for (const adapter of ADAPTERS) {
      const error = await failure(adapter, 401, "User not found.");
      expect(error.code).toBe(ErrorCode.AUTH);
      expect(error.message).toBe(`${adapter.family} rejected the API key (HTTP 401): User not found.`);
    }
    const denied = await failure(openrouter, 403, "Key limit exceeded.");
    expect(denied.message).toBe("openrouter refused access (HTTP 403): Key limit exceeded.");
  });

  test("a request that the provider cannot accept is the caller's to correct, not an internal error", async () => {
    // Both texts are from openrouter.ai: an unknown model id (400) and a model with no tool support (404).
    for (const adapter of ADAPTERS) {
      const error = await failure(adapter, 400, "deepseek/no-such-model-xyz is not a valid model ID");
      expect(error.code).toBe(ErrorCode.INVALID_REQUEST);
    }
    const noTools = await failure(openrouter, 404, "No endpoints found that support tool use.");
    expect(noTools.code).toBe(ErrorCode.INVALID_REQUEST);
  });
});
