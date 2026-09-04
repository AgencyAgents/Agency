import { describe, expect, it } from "bun:test";
import { classifyEffortFromText } from "@agency/providers";
import { ConfigSchema } from "../src/config/schema.ts";
import { runTurn } from "../src/loop.ts";
import { AgentRegistry, parseHandles } from "../src/orchestra/registry.ts";
import { OrchestraTodoStore } from "../src/orchestra/todo.ts";
import { SESSION_SCHEMA_VERSION } from "../src/sessions/entry.ts";

describe("orchestra", () => {
  it("SESSION_SCHEMA_VERSION bumped to 2", () => expect(SESSION_SCHEMA_VERSION).toBe(2));
  it("handle validation", () => {
    expect(() =>
      ConfigSchema.parse({
        schemaVersion: 2,
        agents: {
          leader: { role: "leader", provider: "a", model: "m", effort: "auto", enabled: true },
          Bad: { role: "x", provider: "a", model: "m", effort: "low", enabled: true },
        },
      }),
    ).toThrow();
    expect(() =>
      ConfigSchema.parse({
        schemaVersion: 2,
        agents: {
          leader: { role: "leader", provider: "a", model: "m", effort: "auto", enabled: true },
          "good-handle": { role: "x", provider: "a", model: "m", effort: "auto", enabled: true },
        },
      }),
    ).not.toThrow();
  });
  it("@handle parsing", () => expect(parseHandles("hello @leader and @smith")).toEqual(["leader", "smith"]));
  it("registry drain", () => {
    const r = new AgentRegistry();
    r.register({
      handle: "a",
      role: "r",
      provider: "p",
      model: "m",
      effort: "low",
      sessionId: "s",
      mailbox: [],
    });
    r.enqueue("a", { role: "user", content: [{ type: "text", text: "hi" }] });
    expect(r.drain("a").length).toBe(1);
    expect(r.drain("a").length).toBe(0);
  });
  it("orchestra todo claim sets claimedBy + pending→in_progress, release clears", () => {
    const s = new OrchestraTodoStore();
    s.replace([{ id: "1", content: "t", status: "pending" }]);
    expect(s.claim("a", "1").ok).toBe(true);
    const claimed = s.list().find((t) => t.id === "1");
    expect(claimed?.claimedBy).toBe("a");
    expect(claimed?.status).toBe("in_progress");
    expect(s.claim("a", "1").ok).toBe(true);
    expect(s.claim("b", "1").ok).toBe(false);
    expect(s.release("b", "1").ok).toBe(false);
    expect(s.release("a", "1").ok).toBe(true);
    expect(s.list().find((t) => t.id === "1")?.claimedBy).toBeUndefined();
  });
  it("orchestra todo claim does not regress non-pending status", () => {
    const s = new OrchestraTodoStore();
    s.replace([{ id: "1", content: "t", status: "ready_for_review" }]);
    expect(s.claim("a", "1").ok).toBe(true);
    expect(s.list().find((t) => t.id === "1")?.status).toBe("ready_for_review");
  });
  it("orchestra todo persist callback fires on claim/release/setStatus/replace", async () => {
    const seen: { id: string; status: string; claimedBy?: string }[][] = [];
    const s = new OrchestraTodoStore({
      persist: async (todos) => {
        seen.push(todos.map((t) => ({ ...t })));
      },
    });
    s.replace([{ id: "1", content: "t", status: "pending" }]);
    s.claim("a", "1");
    s.release("a", "1");
    s.claim("a", "1");
    s.setStatus("a", "1", "ready_for_review");
    await new Promise((r) => setTimeout(r, 0));
    expect(seen.length).toBe(5);
    expect(seen[1]?.[0]?.claimedBy).toBe("a");
    expect(seen[1]?.[0]?.status).toBe("in_progress");
    expect(seen[2]?.[0]?.claimedBy).toBeUndefined();
    expect(seen[4]?.[0]?.claimedBy).toBeUndefined();
    expect(seen[4]?.[0]?.status).toBe("ready_for_review");
    expect(s.setStatus("b", "1", "completed").ok).toBe(true);
  });
  it("ready_for_review gate", () => {
    const s = new OrchestraTodoStore();
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
        yield {
          type: "message_stop" as const,
          stopReason: "tool_use" as const,
          usage: { inputTokens: 1, outputTokens: 1 },
        };
      },
    };
    const scheduler = { schedule: (fn: () => Promise<unknown>) => fn() } as never;
    let iterations = 0;
    const http = { fetch: async () => new Response() } as never;
    adapter.stream = async function* () {
      iterations++;
      if (iterations > 5) {
        yield {
          type: "message_stop" as const,
          stopReason: "end_turn" as const,
          usage: { inputTokens: 1, outputTokens: 1 },
        };
        return;
      }
      yield { type: "tool_call_start" as const, id: `c${iterations}`, name: "read" };
      yield {
        type: "tool_call_delta" as const,
        id: `c${iterations}`,
        inputJsonDelta: JSON.stringify({ path: "same" }),
      };
      yield { type: "tool_call_end" as const, id: `c${iterations}` };
      yield {
        type: "message_stop" as const,
        stopReason: "tool_use" as const,
        usage: { inputTokens: 1, outputTokens: 1 },
      };
    } as unknown as typeof adapter.stream;
    const tools = [
      {
        name: "read",
        description: "r",
        inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
        handler: async () => ({ content: "ok" }),
        riskTier: "safe" as const,
      },
    ];
    await expect(
      runTurn(adapter as never, scheduler, http, {
        identity: { type: "user" },
        capabilities: { tools: "*", pathScopes: "*", network: "*" },
        systemPrompt: "sys",
        tools: tools as never,
        model: "m",
        apiKey: "k",
        session: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
        maxToolIterations: 10,
        doomLoopDetection: true,
      }),
    ).rejects.toThrow(/doom loop/);
  });
  it("mailbox drain injects", async () => {
    const msgs: import("@agency/schema").Message[] = [
      { role: "user", content: [{ type: "text", text: "injected" }] },
    ];
    let sawInjected = false;
    const adapter = {
      family: "test",
      async *stream(req: { messages: import("@agency/schema").Message[] }) {
        if (req.messages.some((m) => m.content.some((c) => (c as { text?: string }).text === "injected")))
          sawInjected = true;
        yield {
          type: "message_stop" as const,
          stopReason: "end_turn" as const,
          usage: { inputTokens: 1, outputTokens: 1 },
        };
      },
    };
    const scheduler = { schedule: (fn: () => Promise<unknown>) => fn() } as never;
    const http = { fetch: async () => new Response() } as never;
    await runTurn(adapter as never, scheduler, http, {
      identity: { type: "user" },
      capabilities: { tools: "*", pathScopes: "*", network: "*" },
      systemPrompt: "sys",
      tools: [],
      model: "m",
      apiKey: "k",
      session: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      drainMailbox: () => msgs,
    });
    expect(sawInjected).toBe(true);
  });
});
