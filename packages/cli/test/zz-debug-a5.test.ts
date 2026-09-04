import { test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolSpec } from "@agency/core";
import type { ProviderAdapter, StreamEvent } from "@agency/providers";
import { connectToDaemon } from "@agency/rpc";
import { createAgentDaemon, type RunTurnRpcResult } from "../src/daemon.ts";

function toolCallingAdapter(tool: string, input: unknown): ProviderAdapter {
  let call = 0;
  return {
    family: "fake",
    async *stream(): AsyncGenerator<StreamEvent> {
      call += 1;
      if (call === 1) {
        yield { type: "tool_call_start", id: "c1", name: tool } as StreamEvent;
        yield { type: "tool_call_delta", id: "c1", inputJsonDelta: JSON.stringify(input) } as StreamEvent;
        yield { type: "tool_call_end", id: "c1" } as StreamEvent;
        yield {
          type: "message_stop",
          stopReason: "tool_use",
          usage: { inputTokens: 1, outputTokens: 1 },
        } as StreamEvent;
      } else {
        yield { type: "text_delta", text: "done" } as StreamEvent;
        yield {
          type: "message_stop",
          stopReason: "end_turn",
          usage: { inputTokens: 1, outputTokens: 1 },
        } as StreamEvent;
      }
    },
  } as unknown as ProviderAdapter;
}

test("debug a5 ask path", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dbg-a5-"));
  const noopHttp = { fetch: async () => new Response("{}", { status: 200 }) } as never;
  const dangerousTool: ToolSpec = {
    name: "fakebash",
    description: "d",
    inputSchema: { type: "object" },
    riskTier: "dangerous",
    handler: async () => ({ content: "ran rm -rf build" }),
  } as unknown as ToolSpec;
  const daemon = await createAgentDaemon({
    workspaceRoot: "/repo/fake",
    instanceFile: join(dir, "i.json"),
    adapterFor: () => toolCallingAdapter("fakebash", { command: "rm -rf build" }),
    tools: [dangerousTool],
    http: noopHttp,
  });
  try {
    const client = await connectToDaemon(daemon.server.port, "127.0.0.1", {
      token: daemon.server.token,
    });
    const seen: unknown[] = [];
    client.on("turn.ask-1", (p) => seen.push(p));
    const run1 = client.call("run_turn", {
      turnId: "ask-1",
      provider: "anthropic",
      model: "m",
      apiKey: "key",
      systemPrompt: "sys",
      session: [],
    });
    await new Promise((r) => setTimeout(r, 2000));
    console.log("EVENTS_AFTER_2S:", JSON.stringify(seen).slice(0, 2000));
    const result1 = (await run1) as RunTurnRpcResult;
    console.log("MSGS:", JSON.stringify(result1.messages).slice(0, 2000));
    console.log("STOP:", result1.stopReason, "CANCELLED:", result1.cancelled);
    client.close();
  } finally {
    await daemon.stop();
    rmSync(dir, { recursive: true, force: true });
  }
}, 60_000);
