import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolSpec } from "@agency/core";
import type { HttpClient } from "@agency/net";
import type { ProviderAdapter, StreamEvent } from "@agency/providers";
import { connectToDaemon, type DaemonClient } from "@agency/rpc";
import { type AgentDaemon, createAgentDaemon } from "../src/daemon.ts";

const noopHttp: HttpClient = { fetch: async () => new Response() };
const daemons: AgentDaemon[] = [];
const clients: DaemonClient[] = [];
const dirs: string[] = [];

const prevKey = process.env.AGENCY_ANTHROPIC_API_KEY;
process.env.AGENCY_ANTHROPIC_API_KEY = "test-key-plan";
afterAll(() => {
  if (prevKey === undefined) delete process.env.AGENCY_ANTHROPIC_API_KEY;
  else process.env.AGENCY_ANTHROPIC_API_KEY = prevKey;
});
afterEach(async () => {
  for (const client of clients.splice(0)) await client.close();
  for (const daemon of daemons.splice(0)) await daemon.stop();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

interface Step {
  name: string;
  input: Record<string, unknown>;
}
interface TurnEvent {
  type?: string;
  requestId?: string;
  mode?: string;
  request?: { tool?: string; title?: string };
}
interface SendResult {
  permissionMode?: string;
  messages: unknown;
}

async function start(steps: (Step | undefined)[]) {
  const requests: string[] = [];
  let call = 0;
  const adapter: ProviderAdapter = {
    family: "fake",
    async *stream(request): AsyncIterable<StreamEvent> {
      requests.push(JSON.stringify(request));
      const step = steps[call++];
      if (step === undefined) {
        yield { type: "text_delta", text: "done" };
        yield { type: "message_stop", stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1 } };
        return;
      }
      const id = `call-${call}`;
      yield { type: "tool_call_start", id, name: step.name };
      yield { type: "tool_call_delta", id, inputJsonDelta: JSON.stringify(step.input) };
      yield { type: "tool_call_end", id };
      yield { type: "message_stop", stopReason: "tool_use", usage: { inputTokens: 1, outputTokens: 1 } };
    },
  };
  const workspaceRoot = mkdtempSync(join(tmpdir(), "agency-plan-ws-"));
  const sessionsDir = mkdtempSync(join(tmpdir(), "agency-plan-sess-"));
  dirs.push(workspaceRoot, sessionsDir);
  const ran: string[] = [];
  const tools: ToolSpec[] = [
    {
      name: "write",
      description: "Writes a file.",
      inputSchema: { type: "object", properties: { path: { type: "string" } } },
      riskTier: "moderate",
      handler: async (input) => {
        ran.push("write");
        writeFileSync(join(workspaceRoot, String(input.path)), "x");
        return { content: "written" };
      },
    },
    {
      name: "read",
      description: "Reads a file.",
      inputSchema: { type: "object", properties: { path: { type: "string" } } },
      riskTier: "safe",
      handler: async () => {
        ran.push("read");
        return { content: "file contents" };
      },
    },
  ];
  const daemon = await createAgentDaemon({
    workspaceRoot,
    instanceFile: join(workspaceRoot, ".agency", "instance.json"),
    sessionsDir,
    adapterFor: () => adapter,
    http: noopHttp,
    tools,
  });
  daemons.push(daemon);
  const client = await connectToDaemon(daemon.server.port, "127.0.0.1", { token: daemon.server.token });
  clients.push(client);
  const send = (turnId: string, permissionMode?: string, sessionId = `${turnId}-s`): Promise<SendResult> =>
    client.call("session_send", {
      turnId,
      sessionId,
      provider: "anthropic",
      model: "test-model",
      systemPrompt: "sys",
      userText: "go",
      ...(permissionMode === undefined ? {} : { permissionMode }),
    }) as Promise<SendResult>;
  const events = (turnId: string): TurnEvent[] => {
    const seen: TurnEvent[] = [];
    client.on(`turn.${turnId}`, (p) => seen.push(p as TurnEvent));
    return seen;
  };
  const approval = async (seen: TurnEvent[]): Promise<TurnEvent> => {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const found = seen.find((e) => e.type === "approval_requested");
      if (found) return found;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error("no approval_requested");
  };
  const respond = (requestId: string | undefined, decision: string) =>
    client.call("approval_respond", { requestId, decision });
  return { requests, ran, workspaceRoot, send, events, approval, respond };
}

const PLAN = "# Plan\n1. write a.txt";

describe("plan permission mode", () => {
  test("refuses a write without asking, runs a read, offers plan_exit and the plan reminder", async () => {
    const t = await start([
      { name: "write", input: { path: "a.txt" } },
      { name: "read", input: { path: "a.txt" } },
    ]);
    const seen = t.events("p1");
    const result = await t.send("p1", "plan");
    expect(seen.some((e) => e.type === "approval_requested")).toBe(false);
    expect(existsSync(join(t.workspaceRoot, "a.txt"))).toBe(false);
    expect(t.ran).toEqual(["read"]);
    const messages = JSON.stringify(result.messages);
    expect(messages).toContain("This session is in plan mode");
    expect(messages).toContain("file contents");
    expect(result.permissionMode).toBe("plan");
    expect(t.requests[0]).toContain("Read-only (plan) mode is active");
    expect(t.requests[0]).toContain("plan_exit");
  }, 20_000);

  test("plan_exit and the plan reminder are absent outside plan mode", async () => {
    const t = await start([]);
    const result = await t.send("p0", "allow-edits");
    expect(t.requests[0]).not.toContain("plan_exit");
    expect(t.requests[0]).not.toContain("Read-only (plan) mode");
    expect(result.permissionMode).toBe("allow-edits");
  }, 20_000);

  for (const decision of ["once", "always"]) {
    test(`plan_exit approved with "${decision}": the same turn writes without asking`, async () => {
      const t = await start([
        { name: "plan_exit", input: { plan: PLAN } },
        { name: "write", input: { path: "a.txt" } },
      ]);
      const seen = t.events(`p2${decision}`);
      const run = t.send(`p2${decision}`, "plan");
      const ask = await t.approval(seen);
      expect(ask.request?.tool).toBe("plan_exit");
      expect(ask.request?.title).toBe(PLAN);
      await t.respond(ask.requestId, decision);
      const result = await run;
      expect(existsSync(join(t.workspaceRoot, "a.txt"))).toBe(true);
      expect(seen.filter((e) => e.type === "approval_requested")).toHaveLength(1);
      expect(seen.filter((e) => e.type === "mode_changed")).toEqual([
        { type: "mode_changed", mode: "allow-edits" },
      ]);
      expect(result.permissionMode).toBe("allow-edits");
      expect(JSON.stringify(result.messages)).toContain("approved the plan");
    }, 20_000);
  }

  test('an "always" answer to one plan does not approve the next plan of the session', async () => {
    const t = await start([
      { name: "plan_exit", input: { plan: PLAN } },
      undefined,
      { name: "plan_exit", input: { plan: "# Plan B" } },
    ]);
    const first = t.events("p4");
    const run = t.send("p4", "plan", "p4-s");
    await t.respond((await t.approval(first)).requestId, "always");
    await run;
    const second = t.events("p5");
    const next = t.send("p5", "plan", "p4-s");
    const ask = await t.approval(second);
    expect(ask.request?.title).toBe("# Plan B");
    await t.respond(ask.requestId, "reject");
    expect((await next).permissionMode).toBe("plan");
  }, 20_000);

  test("plan_exit rejected: writes stay refused and the mode stays plan", async () => {
    const t = await start([
      { name: "plan_exit", input: { plan: PLAN } },
      { name: "write", input: { path: "a.txt" } },
    ]);
    const seen = t.events("p3");
    const run = t.send("p3", "plan");
    const ask = await t.approval(seen);
    await t.respond(ask.requestId, "reject");
    const result = await run;
    expect(existsSync(join(t.workspaceRoot, "a.txt"))).toBe(false);
    expect(seen.some((e) => e.type === "mode_changed")).toBe(false);
    expect(seen.filter((e) => e.type === "approval_requested")).toHaveLength(1);
    expect(result.permissionMode).toBe("plan");
    const messages = JSON.stringify(result.messages);
    expect(messages).toContain("The plan was not approved");
    expect(messages).toContain("This session is in plan mode");
  }, 20_000);
});
