/**
 * SDK-only end to end: create, send, stream, approve, cost report, export.
 * Everything past the daemon boot goes through @agency/sdk alone (TCP),
 * proving the published surface covers the loop without private callers.
 * Run: bun scripts/sdk-e2e-10a.ts
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentDaemon } from "../packages/cli/src/daemon.ts";
import type { ToolSpec } from "../packages/core/src/index.ts";
import type { HttpClient } from "../packages/net/src/index.ts";
import type { ProviderAdapter, StreamEvent } from "../packages/providers/src/index.ts";
import { connectToDaemon } from "../packages/rpc/src/index.ts";
import { createAgencyClient } from "../packages/sdk/src/index.ts";

function assert(cond: boolean, what: string): void {
  if (!cond) throw new Error(`sdk-e2e failed: ${what}`);
}

const noopHttp: HttpClient = { fetch: async () => new Response() };

function toolCallingAdapter(toolName: string, input: Record<string, unknown>): ProviderAdapter {
  let call = 0;
  return {
    family: "fake",
    async *stream(): AsyncIterable<StreamEvent> {
      call += 1;
      if (call === 1) {
        yield { type: "tool_call_start", id: "c1", name: toolName };
        yield { type: "tool_call_delta", id: "c1", inputJsonDelta: JSON.stringify(input) };
        yield { type: "tool_call_end", id: "c1" };
        yield { type: "message_stop", stopReason: "tool_use", usage: { inputTokens: 1, outputTokens: 1 } };
      } else {
        yield { type: "text_delta", text: "shipped" };
        yield { type: "message_stop", stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1 } };
      }
    },
  };
}

const dangerousTool: ToolSpec = {
  name: "fakebash",
  description: "fake dangerous tool",
  inputSchema: { type: "object", properties: { command: { type: "string" } } },
  riskTier: "dangerous",
  handler: async (input) => ({ content: `ran ${String((input as { command?: string }).command)}` }),
};

async function main(): Promise<void> {
  process.env.AGENCY_ANTHROPIC_API_KEY ??= "test-key-sdk-e2e";
  const workspaceRoot = mkdtempSync(join(tmpdir(), "agency-sdk-e2e-ws-"));
  const sessionsDir = mkdtempSync(join(tmpdir(), "agency-sdk-e2e-sess-"));
  const approvalsDir = mkdtempSync(join(tmpdir(), "agency-sdk-e2e-appr-"));
  const daemon = await createAgentDaemon({
    workspaceRoot,
    instanceFile: join(workspaceRoot, ".agency", "instance.json"),
    sessionsDir,
    approvalsDir,
    adapterFor: () => toolCallingAdapter("fakebash", { command: "git status" }),
    http: noopHttp,
    tools: [dangerousTool],
  });
  try {
    const raw = await connectToDaemon(daemon.server.port, "127.0.0.1", { token: daemon.server.token });
    const client = createAgencyClient(raw);

    const created = (await client.surface.session_create({ sessionId: "e2e-1" })) as { sessionId: string };
    assert(created.sessionId === "e2e-1", "session_create returns the id");

    const turnId = "e2e-turn-1";
    const streamed: unknown[] = [];
    const off = client.on(`turn.${turnId}`, (payload) => streamed.push(payload));
    const sendPromise = client.surface.session_send({
      sessionId: "e2e-1",
      turnId,
      provider: "anthropic",
      model: "test-model",
      systemPrompt: "sys",
      userText: "run it",
    });

    let requestId = "";
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline && requestId === "") {
      const ask = streamed.find((e) => (e as { type?: string }).type === "approval_requested") as
        | { requestId?: string }
        | undefined;
      if (ask?.requestId) requestId = ask.requestId;
      else await new Promise((r) => setTimeout(r, 50));
    }
    assert(requestId !== "", "approval_requested streamed on the turn channel");
    const answered = (await client.surface.approval_respond({
      requestId,
      decision: "once",
      sessionId: "e2e-1",
    })) as { resolved: boolean };
    assert(answered.resolved === true, "approval_respond resolves the ask");

    const sent = (await sendPromise) as { stopReason: string; tipId: string };
    assert(sent.stopReason === "end_turn", "session_send finishes after approval");
    assert(
      streamed.some((e) => (e as { type?: string }).type === "text_delta"),
      "text streamed",
    );
    off();

    const cost = (await client.surface.cost_report({ sessionId: "e2e-1" })) as {
      sessions: { turns: number }[];
      total: { turns: number };
    };
    assert(cost.sessions[0]?.turns === 1, "cost_report counts the turn");
    assert(cost.total.turns === 1, "cost_report totals the turn");

    const exported = (await client.surface.session_export({ sessionId: "e2e-1" })) as {
      entries: { type: string }[];
    };
    const types = exported.entries.map((e) => e.type);
    assert(types[0] === "message" && types.includes("usage"), "session_export returns messages plus usage");

    const listed = (await client.surface.session_list({})) as { sessions: { id: string }[] };
    assert(
      listed.sessions.some((s) => s.id === "e2e-1"),
      "session_list contains the session",
    );

    await raw.close();
    console.log("sdk-e2e-10a: create, send, stream, approve, cost report, export all green");
    process.exit(0);
  } finally {
    await daemon.stop();
    rmSync(workspaceRoot, { recursive: true, force: true });
    rmSync(sessionsDir, { recursive: true, force: true });
    rmSync(approvalsDir, { recursive: true, force: true });
  }
}

await main();
