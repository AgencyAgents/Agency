import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolSpec } from "@agency/core";
import type { HttpClient } from "@agency/net";
import type { ProviderAdapter, StreamEvent } from "@agency/providers";
import { connectToDaemon, type DaemonClient } from "@agency/rpc";
import type { Message } from "@agency/schema";
import { type AgentDaemon, createAgentDaemon } from "../src/daemon.ts";

const noopHttp: HttpClient = { fetch: async () => new Response() };
const daemons: AgentDaemon[] = [];
const clients: DaemonClient[] = [];
const dirs: string[] = [];

const prevKey = process.env.AGENCY_ANTHROPIC_API_KEY;
process.env.AGENCY_ANTHROPIC_API_KEY = "test-key-midturn";
afterAll(() => {
  if (prevKey === undefined) delete process.env.AGENCY_ANTHROPIC_API_KEY;
  else process.env.AGENCY_ANTHROPIC_API_KEY = prevKey;
});
afterEach(async () => {
  for (const client of clients.splice(0)) await client.close();
  for (const daemon of daemons.splice(0)) await daemon.stop();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("session_message mid-turn steering", () => {
  test("a message sent mid-turn surfaces in the next tool iteration", async () => {
    const seenByCall: Message[][] = [];
    let calls = 0;
    const adapter: ProviderAdapter = {
      family: "fake",
      async *stream(request): AsyncIterable<StreamEvent> {
        calls += 1;
        seenByCall.push([...request.messages]);
        if (calls === 1) {
          yield { type: "tool_call_start", id: "call-1", name: "note" };
          yield { type: "tool_call_delta", id: "call-1", inputJsonDelta: '{"text":"hi"}' };
          yield { type: "tool_call_end", id: "call-1" };
          yield {
            type: "message_stop",
            stopReason: "tool_use",
            usage: { inputTokens: 5, outputTokens: 5 },
          };
          return;
        }
        yield { type: "text_delta", text: "done" };
        yield { type: "message_stop", stopReason: "end_turn", usage: { inputTokens: 5, outputTokens: 5 } };
      },
    };
    const noteTool: ToolSpec = {
      name: "note",
      description: "Records a note.",
      inputSchema: { type: "object", properties: { text: { type: "string" } } },
      riskTier: "safe",
      handler: async () => {
        await new Promise((r) => setTimeout(r, 500));
        return { content: "noted" };
      },
    };

    const workspaceRoot = mkdtempSync(join(tmpdir(), "agency-mid-ws-"));
    dirs.push(workspaceRoot);
    const sessionsDir = mkdtempSync(join(tmpdir(), "agency-mid-sess-"));
    dirs.push(sessionsDir);
    const daemon = await createAgentDaemon({
      workspaceRoot,
      instanceFile: join(workspaceRoot, ".agency", "instance.json"),
      sessionsDir,
      adapterFor: () => adapter,
      http: noopHttp,
      tools: [noteTool],
    });
    daemons.push(daemon);
    const client = await connectToDaemon(daemon.server.port, "127.0.0.1", { token: daemon.server.token });
    clients.push(client);

    const sendPromise = client.call("session_send", {
      turnId: "mid-t1",
      sessionId: "mid-s1",
      provider: "anthropic",
      model: "test-model",
      systemPrompt: "sys",
      userText: "take a note",
    });
    await new Promise((r) => setTimeout(r, 200));
    const queued = (await client.call("session_message", {
      sessionId: "mid-s1",
      text: "steer: prefer blue",
    })) as { queued: boolean; depth: number };
    expect(queued.queued).toBe(true);
    const result = (await sendPromise) as { stopReason: string };
    expect(result.stopReason).toBe("end_turn");

    expect(seenByCall.length).toBe(2);
    const secondTurnText = JSON.stringify(seenByCall[1]);
    expect(secondTurnText).toContain("steer: prefer blue");
  }, 15000);
});
