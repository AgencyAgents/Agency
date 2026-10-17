import { describe, expect, test } from "bun:test";
import { FULL_CAPABILITIES } from "@agency/guard";
import type { HttpClient } from "@agency/net";
import type { ProviderAdapter, StreamEvent } from "@agency/providers";
import { Scheduler } from "@agency/providers";
import { runTurn, type ToolSpec } from "../src/loop.ts";

const http: HttpClient = { fetch: async () => new Response() };
const usage = { inputTokens: 1, outputTokens: 1 };

function call(id: string, name: string, input: Record<string, unknown> = {}): StreamEvent[] {
  return [
    { type: "tool_call_start", id, name },
    { type: "tool_call_delta", id, inputJsonDelta: JSON.stringify(input) },
    { type: "tool_call_end", id },
  ];
}

/** Each reply is a function so a test can wait inside the stream for a tool to start. */
function adapter(replies: Array<() => AsyncIterable<StreamEvent>>): ProviderAdapter {
  let n = 0;
  return {
    family: "fake",
    stream: () => {
      const reply = replies[n++];
      if (!reply) throw new Error("no more replies");
      return reply();
    },
  };
}

async function* done(): AsyncIterable<StreamEvent> {
  yield { type: "text_delta", text: "done" };
  yield { type: "message_stop", stopReason: "end_turn", usage };
}

function tool(name: string, extra: Partial<ToolSpec>, handler: ToolSpec["handler"]): ToolSpec {
  return {
    name,
    description: name,
    inputSchema: { type: "object", properties: {} },
    handler,
    ...extra,
  };
}

function run(a: ProviderAdapter, tools: ToolSpec[]) {
  return runTurn(a, new Scheduler({ maxConcurrent: 4, requestsPerMinute: 6000 }), http, {
    identity: { type: "user" },
    capabilities: FULL_CAPABILITIES,
    systemPrompt: "sys",
    tools,
    model: "m",
    apiKey: "k",
    session: [{ role: "user", content: [{ type: "text", text: "go" }] }],
  });
}

describe("tool overlap", () => {
  test("read-only calls of a tool that is not safe run at the same time", async () => {
    let running = 0;
    let peak = 0;
    const net = tool("net", { riskTier: "moderate", readOnly: () => true }, async () => {
      running += 1;
      peak = Math.max(peak, running);
      await new Promise((r) => setTimeout(r, 30));
      running -= 1;
      return { content: "ok" };
    });
    const a = adapter([
      async function* () {
        yield* call("a", "net");
        yield* call("b", "net");
        yield { type: "message_stop", stopReason: "tool_use", usage };
      },
      done,
    ]);
    await run(a, [net]);
    expect(peak).toBe(2);
  });

  test("a call that is not read-only for its input runs alone", async () => {
    let running = 0;
    let peak = 0;
    const sh = tool("sh", { riskTier: "dangerous", readOnly: (input) => input.ro === true }, async () => {
      running += 1;
      peak = Math.max(peak, running);
      await new Promise((r) => setTimeout(r, 20));
      running -= 1;
      return { content: "ok" };
    });
    const a = adapter([
      async function* () {
        yield* call("a", "sh", { ro: false });
        yield* call("b", "sh", { ro: false });
        yield { type: "message_stop", stopReason: "tool_use", usage };
      },
      done,
    ]);
    await run(a, [sh]);
    expect(peak).toBe(1);
  });

  test("a read-only call starts while the reply still streams", async () => {
    let began!: () => void;
    const started = new Promise<void>((r) => {
      began = r;
    });
    const read = tool("read", { riskTier: "safe" }, async () => {
      began();
      return { content: "text" };
    });
    const a = adapter([
      async function* () {
        yield* call("a", "read");
        // The stream goes on only once the tool has started: without the early start this waits forever.
        await started;
        yield { type: "message_stop", stopReason: "tool_use", usage };
      },
      done,
    ]);
    const result = await run(a, [read]);
    const results = result.messages.flatMap((m) => m.content).filter((b) => b.type === "tool_result");
    expect(results.map((b) => b.type === "tool_result" && b.content)).toEqual(["text"]);
  });

  test("a read after a write in the same reply waits for the write", async () => {
    const order: string[] = [];
    const write = tool("write", { riskTier: "moderate" }, async () => {
      order.push("write");
      return { content: "written" };
    });
    const read = tool("read", { riskTier: "safe" }, async () => {
      order.push("read");
      return { content: "text" };
    });
    const a = adapter([
      async function* () {
        yield* call("a", "write");
        yield* call("b", "read");
        await new Promise((r) => setTimeout(r, 20));
        yield { type: "message_stop", stopReason: "tool_use", usage };
      },
      done,
    ]);
    await run(a, [write, read]);
    expect(order).toEqual(["write", "read"]);
  });

  test("an early call whose result the turn does not use is cancelled", async () => {
    let aborted = false;
    const slow = tool("slow", { riskTier: "safe" }, async (_input, ctx) => {
      await new Promise<void>((r) => {
        ctx.signal.addEventListener("abort", () => {
          aborted = true;
          r();
        });
      });
      return { content: "late" };
    });
    const a = adapter([
      async function* () {
        yield* call("a", "slow");
        yield { type: "text_delta", text: "changed my mind" };
        yield { type: "message_stop", stopReason: "end_turn", usage };
      },
    ]);
    await run(a, [slow]);
    expect(aborted).toBe(true);
  });
});
