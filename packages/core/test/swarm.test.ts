import { describe, it, expect } from "bun:test";
import { parseHandles, AgentRegistry } from "../src/swarm/registry.ts";
import { SwarmTodoStore } from "../src/swarm/todo.ts";
import { classifyEffortFromText } from "@agency/providers";
import { runTurn } from "../src/loop.ts";
import { ConfigSchema } from "../src/config/schema.ts";
import { SESSION_SCHEMA_VERSION, isAgentMessageEntry, isAgentLifecycleEntry } from "../src/sessions/entry.ts";

describe("swarm", () => {
  it("SESSION_SCHEMA_VERSION bumped to 2", () => expect(SESSION_SCHEMA_VERSION).toBe(2));
  it("handle validation", () => {
    expect(() => ConfigSchema.parse({ schemaVersion: 2, agents: { "Bad": { role: "x", provider: "a", model: "m", effort: "low" } } })).toThrow();
    expect(() => ConfigSchema.parse({ schemaVersion: 2, agents: { "good-handle": { role: "x", provider: "a", model: "m", effort: "auto" } } })).not.toThrow();
  });
  it("@handle parsing", () => expect(parseHandles("hello @marshal and @smith")).toEqual(["marshal", "smith"]));
  it("registry drain", () => {
    const r = new AgentRegistry();
    r.register({ handle: "a", role: "r", provider: "p", model: "m", effort: "low", sessionId: "s", mailbox: [] });
    r.enqueue("a", { role: "user", content: [{ type: "text", text: "hi" }] });
    expect(r.drain("a").length).toBe(1);
    expect(r.drain("a").length).toBe(0);
  });
  it("swarm todo claim conflict", () => {
    const s = new SwarmTodoStore();
    s.replace([{ id: "1", content: "t", status: "pending" }]);
    expect(s.claim("a", "1").ok).toBe(true);
    expect(s.claim("b", "1").ok).toBe(false);
    expect(s.release("b", "1").ok).toBe(false);
    expect(s.release("a", "1").ok).toBe(true);
  });
  it("ready_for_review gate", () => {
    const s = new SwarmTodoStore();
    s.replace([{ id: "1", content: "t", status: "pending" }]);
    s.claim("a", "1");
    expect(s.setStatus("a", "1", "completed").ok).toBe(false);
    expect(s.setStatus("a", "1", "ready_for_review").ok).toBe(true);
  });
  it("effort classification", () => expect(classifyEffortFromText("fix typo")).toBe("low"));
  it("doom loop detection", async () => {
    const adapter = {
      family: "test",
      async *stream() {
        yield { type: "tool_call_start" as const, id: "c1", name: "read" };
        yield { type: "tool_call_delta" as const, id: "c1", inputJsonDelta: JSON.stringify({ path: "a" }) };
        yield { type: "tool_call_end" as const, id: "c1" };
        yield { type: "message_stop" as const, stopReason: "tool_use" as const, usage: { inputTokens: 1, outputTokens: 1 } };
      },
    };
    const scheduler = { schedule: (fn: () => Promise<unknown>) => fn() } as never;
    let iterations = 0;
    const http = { fetch: async () => new Response() } as never;
    adapter.stream = async function* () {
      iterations++;
      if (iterations > 5) {
        yield { type: "message_stop" as const, stopReason: "end_turn" as const, usage: { inputTokens: 1, outputTokens: 1 } };
        return;
      }
      yield { type: "tool_call_start" as const, id: `c${iterations}`, name: "read" };
      yield { type: "tool_call_delta" as const, id: `c${iterations}`, inputJsonDelta: JSON.stringify({ path: "same" }) };
      yield { type: "tool_call_end" as const, id: `c${iterations}` };
      yield { type: "message_stop" as const, stopReason: "tool_use" as const, usage: { inputTokens: 1, outputTokens: 1 } };
    };
    const tools = [{ name: "read", description: "r", inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] }, handler: async () => ({ content: "ok" }), riskTier: "safe" as const }];
    await expect(runTurn(adapter as never, scheduler, http, {
      identity: { type: "user" },
      capabilities: { tools: "*", pathScopes: "*", network: "*" },
      systemPrompt: "sys",
      tools: tools as never,
      model: "m",
      apiKey: "k",
      session: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      maxToolIterations: 10,
      doomLoopDetection: true,
    })).rejects.toThrow(/doom loop/);
  });
  it("mailbox drain injects", async () => {
    const msgs: import("@agency/schema").Message[] = [{ role: "user", content: [{ type: "text", text: "injected" }] }];
    let sawInjected = false;
    const adapter = {
      family: "test",
      async *stream(req: { messages: import("@agency/schema").Message[] }) {
        if (req.messages.some((m) => m.content.some((c) => (c as { text?: string }).text === "injected")) ) sawInjected = true;
        yield { type: "message_stop" as const, stopReason: "end_turn" as const, usage: { inputTokens: 1, outputTokens: 1 } };
      },
    };
    const scheduler = { schedule: (fn: () => Promise<unknown>) => fn() } as never;
    const http = { fetch: async () => new Response() } as never;
    await runTurn(adapter as never, scheduler, http, {
      identity: { type: "user" }, capabilities: { tools: "*", pathScopes: "*", network: "*" },
      systemPrompt: "sys", tools: [], model: "m", apiKey: "k",
      session: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      drainMailbox: () => msgs,
    });
    expect(sawInjected).toBe(true);
  });
});
