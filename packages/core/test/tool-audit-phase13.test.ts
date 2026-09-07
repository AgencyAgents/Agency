import { describe, expect, test } from "bun:test";
import { FULL_CAPABILITIES } from "@agency/guard";
import type { HttpClient } from "@agency/net";
import type { ProviderAdapter, StreamEvent } from "@agency/providers";
import { Scheduler } from "@agency/providers";
import { runTurn, type ToolSpec } from "../src/loop.ts";

const noopHttp: HttpClient = { fetch: async () => new Response() };
const user = { type: "user" as const };

function toolThenDoneAdapter(toolName: string, input: Record<string, unknown>): ProviderAdapter {
  let call = 0;
  return {
    family: "fake",
    async *stream(): AsyncIterable<StreamEvent> {
      call += 1;
      if (call === 1) {
        yield { type: "tool_call_start", id: "call_1", name: toolName };
        yield { type: "tool_call_delta", id: "call_1", inputJsonDelta: JSON.stringify(input) };
        yield { type: "tool_call_end", id: "call_1" };
        yield { type: "message_stop", stopReason: "tool_use", usage: { inputTokens: 1, outputTokens: 1 } };
      } else {
        yield { type: "text_delta", text: "done" };
        yield { type: "message_stop", stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1 } };
      }
    },
  };
}

function specFor(name: string, result: { content: string; isError?: boolean }): ToolSpec {
  return {
    name,
    description: `${name} tool`,
    inputSchema: {},
    handler: async () => result,
  };
}

async function runWithAudit(
  toolName: string,
  input: Record<string, unknown>,
  result: { content: string; isError?: boolean } = { content: "ok" },
): Promise<{ audits: unknown[] }> {
  const seen: Array<{ event: string; payload: unknown }> = [];
  const scheduler = new Scheduler();
  await runTurn(toolThenDoneAdapter(toolName, input), scheduler, noopHttp, {
    identity: user,
    capabilities: FULL_CAPABILITIES,
    systemPrompt: "sys",
    tools: [specFor(toolName, result)],
    model: "test-model",
    apiKey: "key",
    session: [],
    sessionId: "sess-1",
    turnId: "turn-1",
    eventBus: { emit: (event, payload) => void seen.push({ event, payload }) },
  });
  return { audits: seen.filter((s) => s.event === "tool.audit").map((s) => s.payload) };
}

describe("workspace audit log", () => {
  test("write, edit, and bash calls each emit one structured tool.audit event", async () => {
    const write = await runWithAudit("write", { path: "a.ts" });
    const edit = await runWithAudit("edit", { path: "b.ts" });
    const bash = await runWithAudit("bash", { command: "git status" });

    expect(write.audits).toEqual([
      { tool: "write", target: "a.ts", isError: false, sessionId: "sess-1", turnId: "turn-1" },
    ]);
    expect(edit.audits).toEqual([
      { tool: "edit", target: "b.ts", isError: false, sessionId: "sess-1", turnId: "turn-1" },
    ]);
    expect(bash.audits).toEqual([
      { tool: "bash", target: "git status", isError: false, sessionId: "sess-1", turnId: "turn-1" },
    ]);
  });

  test("read-only calls emit no audit event", async () => {
    const { audits } = await runWithAudit("read", { path: "a.ts" });

    expect(audits).toEqual([]);
  });

  test("a failed mutating call is still audited with isError set", async () => {
    const { audits } = await runWithAudit("bash", { command: "exit 1" }, { content: "boom", isError: true });

    expect(audits).toEqual([
      { tool: "bash", target: "exit 1", isError: true, sessionId: "sess-1", turnId: "turn-1" },
    ]);
  });
});
