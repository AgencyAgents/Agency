import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolSpec } from "@agency/core";
import { ApprovalManager, PermissionsGate } from "@agency/guard";
import type { HttpClient } from "@agency/net";
import type { ProviderAdapter, StreamEvent } from "@agency/providers";
import { connectToDaemon, type DaemonClient } from "@agency/rpc";
import { type AgentDaemon, createAgentDaemon, type RunTurnRpcResult } from "../src/daemon.ts";

const noopHttp: HttpClient = { fetch: async () => new Response() };

const daemons: AgentDaemon[] = [];
const clients: DaemonClient[] = [];
const dirs: string[] = [];

const prevKey = process.env.AGENCY_ANTHROPIC_API_KEY;
process.env.AGENCY_ANTHROPIC_API_KEY = "test-key-approval";
const prevOffline = process.env.AGENCY_DISABLE_MODELS_FETCH;
process.env.AGENCY_DISABLE_MODELS_FETCH = "1";

afterEach(async () => {
  for (const client of clients.splice(0)) await client.close();
  for (const daemon of daemons.splice(0)) await daemon.stop();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  if (prevKey === undefined) delete process.env.AGENCY_ANTHROPIC_API_KEY;
  else process.env.AGENCY_ANTHROPIC_API_KEY = prevKey;
  if (prevOffline === undefined) delete process.env.AGENCY_DISABLE_MODELS_FETCH;
  else process.env.AGENCY_DISABLE_MODELS_FETCH = prevOffline;
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

function toolCallingAdapter(toolName: string, input: Record<string, unknown>): ProviderAdapter {
  let call = 0;
  return {
    family: "fake",
    async *stream(): AsyncIterable<StreamEvent> {
      call += 1;
      if (call % 2 === 1) {
        yield { type: "tool_call_start", id: `c${call}`, name: toolName } as StreamEvent;
        yield {
          type: "tool_call_delta",
          id: `c${call}`,
          inputJsonDelta: JSON.stringify(input),
        } as StreamEvent;
        yield { type: "tool_call_end", id: `c${call}` } as StreamEvent;
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

function countingTool(calls: { count: number }): ToolSpec {
  return {
    name: "bash",
    description: "fake dangerous tool",
    inputSchema: { type: "object", properties: { command: { type: "string" } } },
    riskTier: "dangerous",
    handler: async (input) => {
      calls.count += 1;
      return { content: `ran ${String((input as { command?: string }).command)}` };
    },
  };
}

async function startDaemon(toolInput: Record<string, unknown>, calls: { count: number }) {
  const workspaceRoot = tempDir("agency-approval-ws-");
  const daemon = await createAgentDaemon({
    workspaceRoot,
    instanceFile: join(workspaceRoot, "instance.json"),
    adapterFor: () => toolCallingAdapter("bash", toolInput),
    tools: [countingTool(calls)],
    http: noopHttp,
    approvalsDir: tempDir("agency-approval-appr-"),
  });
  daemons.push(daemon);
  const client = await connectToDaemon(daemon.server.port, "127.0.0.1", { token: daemon.server.token });
  clients.push(client);
  return {
    daemon,
    client,
    base: `http://127.0.0.1:${daemon.httpPort}`,
    token: daemon.server.token as string,
  };
}

interface ApprovalEvent {
  type?: string;
  requestId?: string;
  sessionId?: string;
  turnId?: string;
  riskTier?: string;
  source?: string;
  argsSummary?: string;
  request?: {
    tool?: string;
    title?: string;
    command?: string;
    path?: string;
    riskTier?: string;
    sessionId?: string;
    turnId?: string;
    source?: string;
    argsSummary?: string;
    metadata?: Record<string, unknown>;
  };
}

async function waitForApproval(events: ApprovalEvent[], timeoutMs = 15_000): Promise<ApprovalEvent> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = events.find((e) => e.type === "approval_requested");
    if (found?.requestId) return found;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("timed out waiting for approval_requested");
}

function runTurn(client: DaemonClient, turnId: string, sessionId: string): Promise<RunTurnRpcResult> {
  return client.call("run_turn", {
    turnId,
    sessionId,
    provider: "anthropic",
    model: "m",
    apiKey: "key",
    systemPrompt: "sys",
    session: [],
  }) as Promise<RunTurnRpcResult>;
}

async function rpcCall(
  base: string,
  token: string,
  method: string,
  params: Record<string, unknown> = {},
): Promise<{ status: number; body: { result?: unknown; error?: { message: string } } }> {
  const res = await fetch(`${base}/rpc`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ id: `req-${method}`, method, params }),
  });
  return {
    status: res.status,
    body: (await res.json()) as { result?: unknown; error?: { message: string } },
  };
}

describe("approval round-trip over a real daemon", () => {
  test("once: SSE carries full context and unblocks the gated call", async () => {
    const calls = { count: 0 };
    const { client } = await startDaemon({ command: "git push origin main" }, calls);
    const turnEvents: ApprovalEvent[] = [];
    const sessionEvents: ApprovalEvent[] = [];
    client.on("turn.rt-once", (p) => turnEvents.push(p as ApprovalEvent));
    client.on("session.rt-once-sess", (p) => sessionEvents.push(p as ApprovalEvent));

    const run = runTurn(client, "rt-once", "rt-once-sess");
    const ask = await waitForApproval(turnEvents);
    expect(typeof ask.requestId).toBe("string");
    expect(ask.sessionId).toBe("rt-once-sess");
    expect(ask.turnId).toBe("rt-once");
    expect(ask.riskTier).toBe("dangerous");
    expect(ask.source).toContain("default");
    expect(ask.argsSummary).toContain("git push origin main");
    expect(ask.request?.tool).toBe("bash");
    expect(ask.request?.command).toBe("git push origin main");
    expect(ask.request?.riskTier).toBe("dangerous");
    expect(ask.request?.sessionId).toBe("rt-once-sess");
    expect(ask.request?.turnId).toBe("rt-once");
    expect(ask.request?.source).toContain("default");
    expect(ask.request?.argsSummary).toContain("git push origin main");
    const mirrored = sessionEvents.find((e) => e.type === "approval_requested");
    expect(mirrored?.requestId).toBe(ask.requestId);

    const responded = (await client.call("approval_respond", {
      requestId: ask.requestId,
      decision: "once",
    })) as { resolved?: boolean };
    expect(responded.resolved).toBe(true);
    const result = await run;
    expect(result.stopReason).toBe("end_turn");
    expect(JSON.stringify(result.messages)).toContain("ran git push origin main");
    expect(calls.count).toBe(1);
    console.log(
      `approval-roundtrip once: source=${ask.source} calls=${calls.count} mirrored=${mirrored !== undefined}`,
    );
  }, 30_000);

  test("always: grants session scope, second turn runs without asking", async () => {
    const calls = { count: 0 };
    const { client } = await startDaemon({ command: "git push origin main" }, calls);
    const events1: ApprovalEvent[] = [];
    client.on("turn.rt-always-1", (p) => events1.push(p as ApprovalEvent));
    const run1 = runTurn(client, "rt-always-1", "rt-always-sess");
    const ask = await waitForApproval(events1);
    const responded = (await client.call("approval_respond", {
      requestId: ask.requestId,
      decision: "always",
    })) as { resolved?: boolean; retroactive?: number };
    expect(responded.resolved).toBe(true);
    await run1;
    expect(calls.count).toBe(1);

    const events2: ApprovalEvent[] = [];
    client.on("turn.rt-always-2", (p) => events2.push(p as ApprovalEvent));
    const result2 = await runTurn(client, "rt-always-2", "rt-always-sess");
    expect(result2.stopReason).toBe("end_turn");
    expect(events2.find((e) => e.type === "approval_requested")).toBeUndefined();
    expect(calls.count).toBe(2);
    console.log(
      `approval-roundtrip always: retroactive=${responded.retroactive} calls=${calls.count} second-ask=none`,
    );
  }, 30_000);

  test("reject: denies typed with zero tool execution", async () => {
    const calls = { count: 0 };
    const { client } = await startDaemon({ command: "rm -rf build" }, calls);
    const events: ApprovalEvent[] = [];
    client.on("turn.rt-reject", (p) => events.push(p as ApprovalEvent));
    const run = runTurn(client, "rt-reject", "rt-reject-sess");
    const ask = await waitForApproval(events);
    const responded = (await client.call("approval_respond", {
      requestId: ask.requestId,
      decision: "reject",
    })) as { resolved?: boolean };
    expect(responded.resolved).toBe(true);
    const result = await run;
    expect(result.stopReason).toBe("end_turn");
    expect(JSON.stringify(result.messages)).toContain("permission denied");
    expect(calls.count).toBe(0);
    console.log(`approval-roundtrip reject: calls=${calls.count} denied-typed=true`);
  }, 30_000);

  test("secret-valued args are redacted over the wire", async () => {
    const secret = "sk-ant-abcdefghij1234567890XYZ";
    const calls = { count: 0 };
    const { client } = await startDaemon({ command: `deploy --token ${secret}` }, calls);
    const events: ApprovalEvent[] = [];
    client.on("turn.rt-secret", (p) => events.push(p as ApprovalEvent));
    const run = runTurn(client, "rt-secret", "rt-secret-sess");
    const ask = await waitForApproval(events);
    const wire = JSON.stringify(ask);
    expect(wire).not.toContain(secret);
    expect(wire).toContain("[REDACTED]");
    expect(ask.argsSummary).not.toContain(secret);
    expect(ask.request?.command).not.toContain(secret);
    await client.call("approval_respond", { requestId: ask.requestId, decision: "reject" });
    await run;
    expect(calls.count).toBe(0);
    console.log("approval-roundtrip redaction: secret-absent placeholder-present=true");
  }, 30_000);

  test("malformed inputs: unknown id, double-respond, garbage decision and id", async () => {
    const calls = { count: 0 };
    const { base, token, client } = await startDaemon({ command: "git status" }, calls);
    const unknown = (await client.call("approval_respond", {
      requestId: "does-not-exist",
      decision: "once",
    })) as { resolved?: boolean; retroactive?: number };
    expect(unknown).toMatchObject({ resolved: false, retroactive: 0 });

    const events: ApprovalEvent[] = [];
    client.on("turn.rt-malformed", (p) => events.push(p as ApprovalEvent));
    const run = runTurn(client, "rt-malformed", "rt-malformed-sess");
    const ask = await waitForApproval(events);
    const first = (await client.call("approval_respond", {
      requestId: ask.requestId,
      decision: "once",
    })) as { resolved?: boolean };
    expect(first.resolved).toBe(true);
    const second = (await client.call("approval_respond", {
      requestId: ask.requestId,
      decision: "once",
    })) as { resolved?: boolean; closeReason?: string };
    expect(second.resolved).toBe(false);
    expect(second.closeReason).toBe("answered");
    await run;

    const badDecision = await rpcCall(base, token, "approval_respond", {
      requestId: ask.requestId,
      decision: "maybe",
    });
    expect(badDecision.status).toBe(500);
    expect(badDecision.body.error?.message ?? "").toContain("invalid approval decision");
    const missingId = await rpcCall(base, token, "approval_respond", { decision: "once" });
    expect(missingId.status).toBe(500);
    expect(missingId.body.error?.message ?? "").toContain("requires requestId");
    console.log("approval-roundtrip malformed: unknown-unresolved double-answered garbage-typed=true");
  }, 30_000);
});

describe("approval timeout and retroactive resolution", () => {
  test("a real 5ms timeout rejects safely with zero tool execution", async () => {
    const manager = new ApprovalManager();
    const gate = new PermissionsGate({ workspaceRoot: tempDir("agency-approval-gate-") });
    let handlerCalls = 0;
    const { id, promise } = manager.createPending(
      { tool: "fakebash", title: "rm -rf build", command: "rm -rf build" },
      "turn-timeout",
      { timeoutMs: 5 },
    );
    const verdict = await gate.check(
      { tool: "fakebash", riskTier: "dangerous", command: "rm -rf build" },
      () => promise,
    );
    expect(verdict).toBe("deny");
    if (verdict === "allow") handlerCalls += 1;
    expect(handlerCalls).toBe(0);
    expect(manager.closeReason(id)).toBe("timeout");
    console.log(`approval-roundtrip timeout: verdict=${verdict} calls=${handlerCalls} reason=timeout`);
  });

  test("a late respond after timeout records the outcome without executing", async () => {
    const manager = new ApprovalManager();
    const { id, promise } = manager.createPending(
      { tool: "fakebash", title: "rm -rf build", command: "rm -rf build" },
      "turn-late",
      { timeoutMs: 5 },
    );
    await expect(promise).resolves.toBe("reject");
    const late = manager.respond(id, "once");
    expect(late.resolved).toBe(false);
    expect(late.closeReason).toBe("timeout");
    expect(manager.pendingCount()).toBe(0);
    console.log(
      `approval-roundtrip retroactive-timeout: resolved=${late.resolved} reason=${late.closeReason}`,
    );
  });

  test("always retroactively resolves sibling asks for the same subject", async () => {
    const manager = new ApprovalManager();
    const same = { tool: "fakebash", title: "bun test", command: "bun test" };
    const first = manager.createPending({ ...same }, "turn-a");
    const second = manager.createPending({ ...same }, "turn-b");
    const outcome = manager.respond(first.id, "always");
    expect(outcome).toMatchObject({ resolved: true, retroactive: 1 });
    await expect(second.promise).resolves.toBe("once");
    expect(manager.hasAlways({ ...same })).toBe(true);
    console.log(`approval-roundtrip retroactive-always: retroactive=${outcome.retroactive}`);
  });
});
