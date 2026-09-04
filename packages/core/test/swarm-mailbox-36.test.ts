import { describe, expect, it } from "bun:test";
import type { Message } from "@agency/schema";
import { runTurn } from "../src/loop.ts";
import { AgentRegistry } from "../src/orchestra/registry.ts";

const msg = (text: string): Message => ({ role: "user", content: [{ type: "text", text }] });

describe("orchestra mailbox correctness (item 36)", () => {
  it("mailbox keyed by handle: enqueue to one handle never leaks to another", () => {
    const r = new AgentRegistry();
    r.register({
      handle: "a",
      role: "r",
      provider: "p",
      model: "m",
      effort: "low",
      sessionId: "s-a",
      mailbox: [],
    });
    r.register({
      handle: "b",
      role: "r",
      provider: "p",
      model: "m",
      effort: "low",
      sessionId: "s-b",
      mailbox: [],
    });
    expect(r.enqueue("a", msg("hi-a"))).toBe(true);
    expect(r.drain("b")).toEqual([]);
    expect(r.drain("a").length).toBe(1);
  });

  it("drain returns copy and clears: mutating result does not resurrect, second drain empty", () => {
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
    r.enqueue("a", msg("one"));
    r.enqueue("a", msg("two"));
    const first = r.drain("a");
    expect(first.length).toBe(2);
    first.push(msg("forged"));
    first.length = 0;
    expect(r.drain("a")).toEqual([]);
    expect(r.peek("a")).toEqual([]);
  });

  it("drainMailbox alias matches drain; unknown handle drains to []", () => {
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
    r.enqueue("a", msg("hi"));
    expect(r.drainMailbox("a").length).toBe(1);
    expect(r.drainMailbox("a")).toEqual([]);
    expect(r.drain("ghost")).toEqual([]);
    expect(r.drainMailbox("ghost")).toEqual([]);
    expect(r.enqueue("ghost", msg("x"))).toBe(false);
  });

  it("steering spliced into next loop iteration without restart", async () => {
    const steering = msg("[from leader] change of plans");
    let drainCalls = 0;
    const drainMailbox = (): Message[] => {
      drainCalls++;
      // Empty at turn start, steering arrives mid-turn (second iteration).
      if (drainCalls === 2) return [steering];
      return [];
    };
    const seenByIteration: string[][] = [];
    let iterations = 0;
    const adapter = {
      family: "test",
      async *stream(req: { messages: Message[] }) {
        iterations++;
        seenByIteration.push(
          req.messages.flatMap((m) => m.content.map((c) => (c as { text?: string }).text ?? "")),
        );
        if (iterations === 1) {
          yield { type: "tool_call_start" as const, id: "c1", name: "read" };
          yield { type: "tool_call_delta" as const, id: "c1", inputJsonDelta: JSON.stringify({ path: "a" }) };
          yield { type: "tool_call_end" as const, id: "c1" };
          yield {
            type: "message_stop" as const,
            stopReason: "tool_use" as const,
            usage: { inputTokens: 1, outputTokens: 1 },
          };
          return;
        }
        yield {
          type: "message_stop" as const,
          stopReason: "end_turn" as const,
          usage: { inputTokens: 1, outputTokens: 1 },
        };
      },
    };
    const scheduler = { schedule: (fn: () => Promise<unknown>) => fn() } as never;
    const http = { fetch: async () => new Response() } as never;
    const tools = [
      {
        name: "read",
        description: "r",
        inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
        handler: async () => ({ content: "ok" }),
        riskTier: "safe" as const,
      },
    ];
    const result = await runTurn(adapter as never, scheduler, http, {
      identity: { type: "user" },
      capabilities: { tools: "*", pathScopes: "*", network: "*" },
      systemPrompt: "sys",
      tools: tools as never,
      model: "m",
      apiKey: "k",
      session: [msg("start")],
      drainMailbox,
      maxToolIterations: 10,
    });
    expect(result.stopReason).toBe("end_turn");
    expect(drainCalls).toBeGreaterThanOrEqual(2);
    expect(seenByIteration.length).toBe(2);
    expect(seenByIteration[0]!.some((t) => t.includes("change of plans"))).toBe(false);
    expect(seenByIteration[1]!.some((t) => t.includes("change of plans"))).toBe(true);
  });
});
