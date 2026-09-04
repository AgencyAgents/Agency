import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Scheduler } from "../../providers/src/scheduler.ts";
import type { ProviderAdapter } from "../../providers/src/types.ts";
import { readCassette, writeCassette } from "../src/cassette.ts";
import { runTurn } from "../src/loop.ts";

function fakeAdapter(text: string): ProviderAdapter {
  return {
    family: "test",
    async *stream() {
      // biome-ignore lint/suspicious/noExplicitAny: test adapter
      yield { type: "text_delta", text } as any;
      yield {
        type: "message_stop",
        stopReason: "end_turn",
        usage: { inputTokens: 1, outputTokens: 1 },
        // biome-ignore lint/suspicious/noExplicitAny: test adapter
      } as any;
    },
  };
}

describe("cassette record/replay", () => {
  test("replays and asserts equality", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cassette-"));
    const scheduler = new Scheduler({ maxAttempts: 1, requestsPerMinute: 1000 });
    // biome-ignore lint/suspicious/noExplicitAny: test data
    const http = { fetch: async () => new Response() } as any;
    const adapter = fakeAdapter("hello");
    // biome-ignore lint/suspicious/noExplicitAny: test data
    const options: any = {
      identity: { type: "user" },
      capabilities: { tools: "*", pathScopes: "*", network: "*" },
      systemPrompt: "sys",
      tools: [],
      model: "test/model",
      apiKey: "k",
      session: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    };
    // biome-ignore lint/suspicious/noExplicitAny: test data
    const events: any[] = [];
    const result = await runTurn(adapter, scheduler, http, { ...options, onEvent: (e) => events.push(e) });
    const record = {
      params: { provider: "test", model: "test/model", systemPrompt: "sys", session: options.session },
      events,
      result,
    };
    const path = join(dir, "c.json");
    // biome-ignore lint/suspicious/noExplicitAny: test data
    writeCassette(path, record as any);
    const loaded = readCassette(path);
    expect(loaded.result.messages.length).toBe(result.messages.length);

    const { replayCassette } = await import("../src/cassette.ts");
    const fresh = fakeAdapter("hello");
    const out = await replayCassette(path, fresh, scheduler, http, {
      identity: options.identity,
      capabilities: options.capabilities,
      tools: [],
      apiKey: "k",
    });
    expect(out.equal).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });
});
