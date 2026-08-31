import { describe, expect, test } from "bun:test";
import type { HttpClient } from "@agency/net";
import type { ProviderAdapter, StreamEvent, Usage } from "@agency/providers";
import { Scheduler } from "@agency/providers";
import { FULL_CAPABILITIES, NO_CAPABILITIES } from "@agency/guard";
import { runTurn, type ToolSpec } from "../src/loop.ts";

const noopHttp: HttpClient = { fetch: async () => new Response() };
const user = { type: "user" as const };

function textTurn(text: string, usage: Usage = { inputTokens: 10, outputTokens: 5 }): ProviderAdapter {
  return {
    family: "fake",
    async *stream(): AsyncIterable<StreamEvent> {
      yield { type: "text_delta", text };
      yield { type: "message_stop", stopReason: "end_turn", usage };
    },
  };
}

/** Adapter that requests a tool call on its first call, then ends the turn on the second. */
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
        yield { type: "message_stop", stopReason: "tool_use", usage: { inputTokens: 10, outputTokens: 5 } };
      } else {
        yield { type: "text_delta", text: "done" };
        yield { type: "message_stop", stopReason: "end_turn", usage: { inputTokens: 10, outputTokens: 5 } };
      }
    },
  };
}

const alwaysCallsTool: ProviderAdapter = {
  family: "fake",
  async *stream(): AsyncIterable<StreamEvent> {
    yield { type: "tool_call_start", id: "call_x", name: "loop_tool" };
    yield { type: "tool_call_delta", id: "call_x", inputJsonDelta: "{}" };
    yield { type: "tool_call_end", id: "call_x" };
    yield { type: "message_stop", stopReason: "tool_use", usage: { inputTokens: 1, outputTokens: 1 } };
  },
};

describe("runTurn", () => {
  test("a plain text turn produces one assistant message and end_turn", async () => {
    const scheduler = new Scheduler();
    const result = await runTurn(textTurn("hello there"), scheduler, noopHttp, {
      identity: user,
      capabilities: FULL_CAPABILITIES,
      systemPrompt: "you are helpful",
      tools: [],
      model: "test-model",
      apiKey: "key",
      session: [],
    });

    expect(result.stopReason).toBe("end_turn");
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]).toEqual({ role: "assistant", content: [{ type: "text", text: "hello there" }] });
    expect(result.usage).toEqual({ inputTokens: 10, outputTokens: 5, cachedInputTokens: 0 });
  });

  test("a tool call round-trips through the handler and a second provider call", async () => {
    let handlerCalled: unknown;
    const spec: ToolSpec = {
      name: "read",
      description: "reads a file",
      inputSchema: {},
      handler: async (input) => {
        handlerCalled = input;
        return { content: "file contents" };
      },
    };

    const scheduler = new Scheduler();
    const result = await runTurn(toolThenDoneAdapter("read", { path: "a.ts" }), scheduler, noopHttp, {
      identity: user,
      capabilities: FULL_CAPABILITIES,
      systemPrompt: "sys",
      tools: [spec],
      model: "test-model",
      apiKey: "key",
      session: [],
    });

    expect(handlerCalled).toEqual({ path: "a.ts" });
    expect(result.stopReason).toBe("end_turn");
    // assistant(tool_call) -> user(tool_result) -> assistant(text)
    expect(result.messages).toHaveLength(3);
    expect(result.messages[0]!.content[0]).toMatchObject({ type: "tool_call", name: "read", input: { path: "a.ts" } });
    expect(result.messages[1]!.content[0]).toMatchObject({ type: "tool_result", content: "file contents", isError: false });
    expect(result.messages[2]!.content[0]).toMatchObject({ type: "text", text: "done" });
  });

  test("a capability denial produces a tool_result error without invoking the handler", async () => {
    let handlerCalled = false;
    const spec: ToolSpec = {
      name: "bash",
      description: "runs a command",
      inputSchema: {},
      handler: async () => {
        handlerCalled = true;
        return { content: "ran" };
      },
    };

    const scheduler = new Scheduler();
    const result = await runTurn(toolThenDoneAdapter("bash", {}), scheduler, noopHttp, {
      identity: user,
      capabilities: NO_CAPABILITIES,
      systemPrompt: "sys",
      tools: [spec],
      model: "test-model",
      apiKey: "key",
      session: [],
    });

    expect(handlerCalled).toBe(false);
    const toolResult = result.messages[1]!.content[0] as { type: string; isError: boolean; content: string };
    expect(toolResult.isError).toBe(true);
    expect(toolResult.content).toMatch(/not allowed|outside/i);
  });

  test("an unknown tool name produces a tool_result error, not a crash", async () => {
    const scheduler = new Scheduler();
    const result = await runTurn(toolThenDoneAdapter("nonexistent", {}), scheduler, noopHttp, {
      identity: user,
      capabilities: FULL_CAPABILITIES,
      systemPrompt: "sys",
      tools: [],
      model: "test-model",
      apiKey: "key",
      session: [],
    });

    const toolResult = result.messages[1]!.content[0] as { isError: boolean; content: string };
    expect(toolResult.isError).toBe(true);
    expect(toolResult.content).toContain("no such tool");
  });

  test("a tool handler that throws becomes a tool_result error, not an unhandled rejection", async () => {
    const spec: ToolSpec = {
      name: "flaky",
      description: "fails",
      inputSchema: {},
      handler: async () => {
        throw new Error("disk full");
      },
    };

    const scheduler = new Scheduler();
    const result = await runTurn(toolThenDoneAdapter("flaky", {}), scheduler, noopHttp, {
      identity: user,
      capabilities: FULL_CAPABILITIES,
      systemPrompt: "sys",
      tools: [spec],
      model: "test-model",
      apiKey: "key",
      session: [],
    });

    const toolResult = result.messages[1]!.content[0] as { isError: boolean; content: string };
    expect(toolResult.isError).toBe(true);
    expect(toolResult.content).toBe("disk full");
  });

  test("stops and reports budgetExceeded once the token budget is hit, without running tools", async () => {
    let handlerCalled = false;
    const spec: ToolSpec = {
      name: "read",
      description: "reads",
      inputSchema: {},
      handler: async () => {
        handlerCalled = true;
        return { content: "x" };
      },
    };

    const scheduler = new Scheduler();
    const result = await runTurn(toolThenDoneAdapter("read", {}), scheduler, noopHttp, {
      identity: user,
      capabilities: FULL_CAPABILITIES,
      systemPrompt: "sys",
      tools: [spec],
      model: "test-model",
      apiKey: "key",
      session: [],
      budget: { maxTokens: 10 }, // first turn's usage (10 in + 5 out = 15) already exceeds this
    });

    expect(result.budgetExceeded).toBe(true);
    expect(handlerCalled).toBe(false);
    expect(result.messages).toHaveLength(1); // only the assistant tool_use message, no tool round-trip
  });

  test("maxToolIterations caps a runaway tool-calling loop", async () => {
    let calls = 0;
    const spec: ToolSpec = {
      name: "loop_tool",
      description: "always gets called again",
      inputSchema: {},
      handler: async () => {
        calls += 1;
        return { content: "ok" };
      },
    };

    const scheduler = new Scheduler();
    const result = await runTurn(alwaysCallsTool, scheduler, noopHttp, {
      identity: user,
      capabilities: FULL_CAPABILITIES,
      systemPrompt: "sys",
      tools: [spec],
      model: "test-model",
      apiKey: "key",
      session: [],
      maxToolIterations: 3,
    });

    expect(calls).toBe(3);
    expect(result.stopReason).toBe("tool_use"); // capped mid-loop, never reached a natural stop
  });

  test("emits streaming events as the turn progresses", async () => {
    const events: string[] = [];
    const scheduler = new Scheduler();
    await runTurn(textTurn("streamed"), scheduler, noopHttp, {
      identity: user,
      capabilities: FULL_CAPABILITIES,
      systemPrompt: "sys",
      tools: [],
      model: "test-model",
      apiKey: "key",
      session: [],
      onEvent: (e) => events.push(e.type),
    });

    expect(events).toEqual(["text_delta", "turn_complete"]);
  });

  test("aborting the run's signal propagates into a running tool and actually kills its process", async () => {
    const controller = new AbortController();
    let processExited = false;

    const spec: ToolSpec = {
      name: "long_running",
      description: "a real subprocess that only a real kill signal stops",
      inputSchema: {},
      handler: async (_input, ctx) => {
        const proc = Bun.spawn(["node", "-e", "setInterval(() => {}, 1000)"]);
        const killIfAborted = () => proc.kill();
        ctx.signal.addEventListener("abort", killIfAborted);
        await proc.exited;
        processExited = true;
        ctx.signal.removeEventListener("abort", killIfAborted);
        return { content: "killed" };
      },
    };

    const scheduler = new Scheduler();
    const resultPromise = runTurn(toolThenDoneAdapter("long_running", {}), scheduler, noopHttp, {
      identity: user,
      capabilities: FULL_CAPABILITIES,
      systemPrompt: "sys",
      tools: [spec],
      model: "test-model",
      apiKey: "key",
      session: [],
      signal: controller.signal,
    });

    // Give the subprocess a moment to actually start, then cancel.
    await new Promise((r) => setTimeout(r, 200));
    controller.abort();

    await resultPromise;
    expect(processExited).toBe(true);
  }, 10_000);
});
