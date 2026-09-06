import { expect, test } from "bun:test";
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
  };
  const daemon = await createAgentDaemon({
    workspaceRoot: dir,
    instanceFile: join(dir, "i.json"),
    adapterFor: () => toolCallingAdapter("fakebash", { command: "rm -rf build" }),
    tools: [dangerousTool],
    http: noopHttp,
    // Hermetic grants: the real approvals dir may carry a stale "always"
    // for fakebash from interactive use, which would auto-answer the ask
    // and hide the very gate this test exercises.
    approvalsDir: join(dir, "approvals"),
  });
  try {
    const client = await connectToDaemon(daemon.server.port, "127.0.0.1", {
      token: daemon.server.token,
    });
    try {
      const seen: Array<{ type?: string; requestId?: string }> = [];
      client.on("turn.ask-1", (p) => seen.push(p as { type?: string; requestId?: string }));
      const run = client.call("run_turn", {
        turnId: "ask-1",
        provider: "anthropic",
        model: "m",
        apiKey: "key",
        systemPrompt: "sys",
        session: [],
      }) as Promise<RunTurnRpcResult>;
      // The dangerous tool pauses the turn at the ask gate: answer it the
      // way the UI would instead of awaiting a promise nothing resolves.
      const deadline = Date.now() + 15_000;
      let requestId: string | undefined;
      while (Date.now() < deadline) {
        requestId = seen.find((e) => e.type === "approval_requested")?.requestId;
        if (requestId) break;
        await new Promise((r) => setTimeout(r, 50));
      }
      expect(requestId).toBeTruthy();
      const responded = (await client.call("approval_respond", {
        requestId: requestId!,
        decision: "once",
      })) as { resolved?: boolean };
      expect(responded.resolved).toBe(true);
      const result1 = await run;
      expect(result1.cancelled).toBeFalsy();
      expect(result1.stopReason).toBe("end_turn");
      expect(JSON.stringify(result1.messages)).toContain("ran rm -rf build");
    } finally {
      await client.close();
    }
  } finally {
    await daemon.stop();
    rmSync(dir, { recursive: true, force: true });
  }
}, 30_000);
