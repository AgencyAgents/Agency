import { expect, test } from "bun:test";
import type { Config, ToolSpec } from "@agency/core";
import type { ProviderAdapter, StreamEvent } from "@agency/providers";
import { Scheduler } from "@agency/providers";
import { agentHookModel } from "../src/daemon/types.ts";

test("an agent hook runs a turn with the read tools of its session, and answers with its last reply", async () => {
  let requests = 0;
  const adapter: ProviderAdapter = {
    family: "fake",
    async *stream(): AsyncIterable<StreamEvent> {
      requests += 1;
      if (requests === 1) {
        yield { type: "tool_call_start", id: "c1", name: "read" };
        yield { type: "tool_call_delta", id: "c1", inputJsonDelta: JSON.stringify({ path: "test.log" }) };
        yield { type: "tool_call_end", id: "c1" };
        yield { type: "message_stop", stopReason: "tool_use", usage: { inputTokens: 1, outputTokens: 1 } };
      } else {
        yield { type: "text_delta", text: '{"ok": false, "reason": "2 tests fail"}' };
        yield { type: "message_stop", stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1 } };
      }
    },
  };
  const seen: string[] = [];
  const read: ToolSpec = {
    name: "read",
    description: "reads a file",
    inputSchema: { type: "object", properties: { path: { type: "string" } } },
    handler: async (input) => {
      seen.push(`read ${String(input.path)}`);
      return { content: "2 failed" };
    },
  };
  const ask = agentHookModel({
    config: { model: "fakeprov/m1" } as Config,
    providers: {},
    adapterFor: () => adapter,
    http: { fetch: async () => new Response() },
    getKeychain: async () => {
      throw new Error("no keychain");
    },
    schedulerFor: () => new Scheduler(),
    toolsFor: async (sessionId) => {
      seen.push(`tools of ${sessionId}`);
      return [read];
    },
  });
  process.env.AGENCY_FAKEPROV_API_KEY = "k";
  try {
    const reply = await ask("Do the tests pass?", undefined, new AbortController().signal, "s9");
    expect(reply).toBe('{"ok": false, "reason": "2 tests fail"}');
    expect(seen).toEqual(["tools of s9", "read test.log"]);
  } finally {
    delete process.env.AGENCY_FAKEPROV_API_KEY;
  }
});
