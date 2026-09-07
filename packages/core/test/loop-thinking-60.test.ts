import { describe, expect, test } from "bun:test";
import type { CallerIdentity, Capabilities } from "@agency/guard";
import type { HttpClient } from "@agency/net";
import { type ProviderAdapter, Scheduler, type StreamEvent } from "@agency/providers";
import { runTurn, type ToolSpec } from "../src/loop.ts";

const noopHttp: HttpClient = {
  fetch: async () => new Response("{}", { status: 200 }),
};
const user: CallerIdentity = { type: "user" };
const FULL_CAPABILITIES: Capabilities = {
  tools: "*",
  network: "*",
  pathScopes: "*",
};

describe("item 60: thinking_signature never dropped", () => {
  test("second signature on an already-signed block starts its own placeholder", async () => {
    const adapter: ProviderAdapter = {
      family: "fake",
      async *stream(): AsyncIterable<StreamEvent> {
        yield { type: "thinking_delta", text: "r1" };
        yield { type: "thinking_signature", signature: "sig-1" };
        yield { type: "thinking_signature", signature: "sig-2" };
        yield { type: "text_delta", text: "answer" };
        yield { type: "message_stop", stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1 } };
      },
    };
    const result = await runTurn(adapter, new Scheduler(), noopHttp, {
      identity: user,
      capabilities: FULL_CAPABILITIES,
      systemPrompt: "sys",
      tools: [] as ToolSpec[],
      model: "m",
      apiKey: "k",
      session: [],
    });
    expect(result.messages[0]?.content).toEqual([
      { type: "thinking", text: "r1", signature: "sig-1" },
      { type: "thinking", text: "", signature: "sig-2" },
      { type: "text", text: "answer" },
    ]);
  });
});
