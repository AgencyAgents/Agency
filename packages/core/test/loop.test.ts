import { describe, expect, test } from "bun:test";
import { FULL_CAPABILITIES, NO_CAPABILITIES } from "@agency/guard";
import type { HttpClient } from "@agency/net";
import type { ProviderAdapter, StreamEvent, Usage } from "@agency/providers";
import { Scheduler } from "@agency/providers";
import type { Message } from "@agency/schema";
import { runTurn, type ToolSpec, validateToolInput } from "../src/loop.ts";

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

/** Adapter that streams a tool call with the given raw argument JSON, then ends the turn. */
function rawJsonAdapter(rawJson: string): ProviderAdapter {
  let call = 0;
  return {
    family: "fake",
    async *stream(): AsyncIterable<StreamEvent> {
      call += 1;
      if (call === 1) {
        yield { type: "tool_call_start", id: "call_1", name: "read" };
        yield { type: "tool_call_delta", id: "call_1", inputJsonDelta: rawJson };
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
    expect(result.messages[0]).toEqual({
      role: "assistant",
      content: [{ type: "text", text: "hello there" }],
    });
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
    expect(result.messages[0]!.content[0]).toMatchObject({
      type: "tool_call",
      name: "read",
      input: { path: "a.ts" },
    });
    expect(result.messages[1]!.content[0]).toMatchObject({
      type: "tool_result",
      content: "file contents",
      isError: false,
    });
    expect(result.messages[2]!.content[0]).toMatchObject({ type: "text", text: "done" });
  });

  test("tool_start events carry the parsed call input for the TUI's renderCall", async () => {
    const spec: ToolSpec = {
      name: "read",
      description: "reads a file",
      inputSchema: {},
      handler: async () => ({ content: "contents" }),
    };
    const events: unknown[] = [];

    const scheduler = new Scheduler();
    await runTurn(toolThenDoneAdapter("read", { path: "a.ts" }), scheduler, noopHttp, {
      identity: user,
      capabilities: FULL_CAPABILITIES,
      systemPrompt: "sys",
      tools: [spec],
      model: "test-model",
      apiKey: "key",
      session: [],
      onEvent: (e) => events.push(e),
    });

    const starts = events.filter((e) => (e as { type: string }).type === "tool_start");
    expect(starts).toEqual([{ type: "tool_start", id: "call_1", name: "read", input: { path: "a.ts" } }]);
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

  test("near-miss tool-call JSON is repaired instead of killing the turn", async () => {
    let handlerCalled: unknown;
    const spec: ToolSpec = {
      name: "read",
      description: "reads",
      inputSchema: {},
      handler: async (input) => {
        handlerCalled = input;
        return { content: "file contents" };
      },
    };

    const scheduler = new Scheduler();
    const result = await runTurn(rawJsonAdapter('{path: "a.ts",}'), scheduler, noopHttp, {
      identity: user,
      capabilities: FULL_CAPABILITIES,
      systemPrompt: "sys",
      tools: [spec],
      model: "test-model",
      apiKey: "key",
      session: [],
    });

    // Unquoted key + trailing comma are repaired; the tool runs normally.
    expect(handlerCalled).toEqual({ path: "a.ts" });
    expect(result.stopReason).toBe("end_turn");
    expect(result.messages).toHaveLength(3);
  });

  test("a stream cut off mid-arguments is repaired by closing the open brace", async () => {
    let handlerCalled: unknown;
    const spec: ToolSpec = {
      name: "read",
      description: "reads",
      inputSchema: {},
      handler: async (input) => {
        handlerCalled = input;
        return { content: "file contents" };
      },
    };

    const scheduler = new Scheduler();
    const result = await runTurn(rawJsonAdapter('{"path": "a.ts"'), scheduler, noopHttp, {
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
  });

  test("unrepairable tool-call JSON becomes a per-call error, not a dead turn", async () => {
    let handlerCalled = false;
    const spec: ToolSpec = {
      name: "read",
      description: "reads",
      inputSchema: {},
      handler: async () => {
        handlerCalled = true;
        return { content: "should not run" };
      },
    };

    const scheduler = new Scheduler();
    const result = await runTurn(rawJsonAdapter('{"path": '), scheduler, noopHttp, {
      identity: user,
      capabilities: FULL_CAPABILITIES,
      systemPrompt: "sys",
      tools: [spec],
      model: "test-model",
      apiKey: "key",
      session: [],
    });

    expect(handlerCalled).toBe(false); // the handler never runs on garbage input
    expect(result.stopReason).toBe("end_turn"); // the turn survives the malformed call
    expect(result.messages).toHaveLength(3); // assistant tool_call, user tool_result, assistant "done"
    const toolResult = result.messages[1]!.content[0] as { isError: boolean; content: string };
    expect(toolResult.isError).toBe(true);
    expect(toolResult.content).toContain("not valid JSON");
  });

  test("stops and reports budgetExceeded once the token budget is hit, after closing out pending tool calls", async () => {
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
    const events: unknown[] = [];

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
      onEvent: (e) => events.push(e),
    });

    expect(result.budgetExceeded).toBe(true);
    // The pending tool call still runs so the persisted conversation stays
    // well-formed: every tool_call gets a matching tool_result (a dangling
    // tool_call would make resuming the session 400 at the provider).
    expect(handlerCalled).toBe(true);
    expect(result.messages).toHaveLength(2); // assistant tool_use + user tool_result, no second provider round-trip
    expect(result.messages[1]!.content[0]).toMatchObject({
      type: "tool_result",
      content: "x",
      isError: false,
    });
    const types = events.map((e) => (e as { type: string }).type);
    expect(types[types.length - 1]).toBe("budget_exceeded");
  });

  test("a tool that returns no text gives a result that says so: an empty result is rejected by strict providers", async () => {
    // Cohere through OpenRouter answers 400 "all elements in tool_results must have the 'outputs' property" for "".
    const silent: ToolSpec = {
      name: "bash",
      description: "runs",
      inputSchema: {},
      handler: async () => ({ content: "" }),
    };
    const result = await runTurn(toolThenDoneAdapter("bash", {}), new Scheduler(), noopHttp, {
      identity: user,
      capabilities: FULL_CAPABILITIES,
      systemPrompt: "sys",
      tools: [silent],
      model: "test-model",
      apiKey: "key",
      session: [],
    });

    expect(result.messages[1]?.content[0]).toMatchObject({ type: "tool_result", content: "(no output)" });
  });

  test("a charge that the provider reports counts against the cost budget with no price table", async () => {
    const charged: ProviderAdapter = {
      family: "fake",
      async *stream(): AsyncIterable<StreamEvent> {
        yield { type: "tool_call_start", id: "call_1", name: "read" };
        yield { type: "tool_call_end", id: "call_1" };
        const usage = { inputTokens: 10, outputTokens: 5, costUsd: 0.02 };
        yield { type: "message_stop", stopReason: "tool_use", usage };
      },
    };
    const result = await runTurn(charged, new Scheduler(), noopHttp, {
      identity: user,
      capabilities: FULL_CAPABILITIES,
      systemPrompt: "sys",
      tools: [
        { name: "read", description: "reads", inputSchema: {}, handler: async () => ({ content: "x" }) },
      ],
      model: "test-model",
      apiKey: "key",
      session: [],
      budget: { maxCostUsd: 0.03 },
    });

    // Two requests at 0.02 pass 0.03. A third request would mean that the charge did not count.
    expect(result.budgetExceeded).toBe(true);
    expect(result.usage.costUsd).toBeCloseTo(0.04, 9);
  });

  test("maxToolIterations caps a runaway tool-calling loop and says so", async () => {
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
    const events: unknown[] = [];

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
      onEvent: (e) => events.push(e),
    });

    expect(calls).toBe(3);
    expect(result.stopReason).toBe("tool_use"); // capped mid-loop, never reached a natural stop
    // The cap is distinguishable from a natural finish: a dedicated event lets
    // the UI show "stopped after N steps, continue?".
    expect(events).toContainEqual({ type: "iteration_limit", iterations: 3 });
    // A caller with no event listener still learns that the work is not finished.
    expect(result.error?.code).toBe("iteration_limit");
  });

  test("with no limit from the caller, a runaway loop stops after 100 steps", async () => {
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
    // The default scheduler paces requests at 60 a minute: 100 requests would take the test over a minute.
    const unpaced = new Scheduler({ requestsPerMinute: 1_000_000 });
    const result = await runTurn(alwaysCallsTool, unpaced, noopHttp, {
      identity: user,
      capabilities: FULL_CAPABILITIES,
      systemPrompt: "sys",
      tools: [spec],
      model: "test-model",
      apiKey: "key",
      session: [],
    });
    expect(calls).toBe(100);
    expect(result.error?.code).toBe("iteration_limit");
  });

  test("a natural finish never emits the iteration_limit event", async () => {
    const events: unknown[] = [];
    const scheduler = new Scheduler();
    await runTurn(textTurn("done"), scheduler, noopHttp, {
      identity: user,
      capabilities: FULL_CAPABILITIES,
      systemPrompt: "sys",
      tools: [],
      model: "test-model",
      apiKey: "key",
      session: [],
      maxToolIterations: 3,
      onEvent: (e) => events.push(e),
    });

    expect(events).not.toContainEqual(expect.objectContaining({ type: "iteration_limit" }));
  });

  test("a tool stop reason with no tool call ends the turn: the loop does not spin", async () => {
    let requests = 0;
    const adapter: ProviderAdapter = {
      family: "fake",
      async *stream(): AsyncIterable<StreamEvent> {
        requests += 1;
        yield { type: "text_delta", text: "nothing to call" };
        yield { type: "message_stop", stopReason: "tool_use", usage: { inputTokens: 1, outputTokens: 1 } };
      },
    };
    const result = await runTurn(adapter, new Scheduler(), noopHttp, {
      identity: user,
      capabilities: FULL_CAPABILITIES,
      systemPrompt: "sys",
      tools: [],
      model: "test-model",
      apiKey: "key",
      session: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      maxToolIterations: 4,
    });

    expect(requests).toBe(1);
    expect(result.stopReason).toBe("end_turn");
    expect(result.error).toBeUndefined();
    expect(result.messages.filter((message) => message.content.length === 0)).toEqual([]);
  });

  test("a reply that is cut at the output limit continues, and the turn ends when the model finishes", async () => {
    const requests: Message[][] = [];
    const adapter: ProviderAdapter = {
      family: "fake",
      async *stream(request): AsyncIterable<StreamEvent> {
        requests.push([...request.messages]);
        const first = requests.length === 1;
        yield { type: "text_delta", text: first ? "part one," : " part two." };
        yield {
          type: "message_stop",
          stopReason: first ? "max_tokens" : "end_turn",
          usage: { inputTokens: 1, outputTokens: 1 },
        };
      },
    };
    const result = await runTurn(adapter, new Scheduler(), noopHttp, {
      identity: user,
      capabilities: FULL_CAPABILITIES,
      systemPrompt: "sys",
      tools: [],
      model: "test-model",
      apiKey: "key",
      session: [{ role: "user", content: [{ type: "text", text: "write a long answer" }] }],
    });

    expect(result.stopReason).toBe("end_turn");
    expect(result.error).toBeUndefined();
    // The second request holds the cut reply and then a user message that tells the model to go on.
    expect(requests[1]?.map((message) => message.role)).toEqual(["user", "assistant", "user"]);
    const texts = result.messages
      .filter((message) => message.role === "assistant")
      .flatMap((message) => message.content)
      .map((block) => (block.type === "text" ? block.text : ""));
    expect(texts).toEqual(["part one,", " part two."]);
  });

  test("a reply that is cut in the middle of a line goes on from its last complete line", async () => {
    const requests: Message[][] = [];
    const adapter: ProviderAdapter = {
      family: "fake",
      async *stream(request): AsyncIterable<StreamEvent> {
        requests.push([...request.messages]);
        const first = requests.length === 1;
        // A real model writes the cut line again from its start.
        yield { type: "text_delta", text: first ? "one\ntwo\nthr" : "three\nfour" };
        yield {
          type: "message_stop",
          stopReason: first ? "max_tokens" : "end_turn",
          usage: { inputTokens: 1, outputTokens: 1 },
        };
      },
    };
    const result = await runTurn(adapter, new Scheduler(), noopHttp, {
      identity: user,
      capabilities: FULL_CAPABILITIES,
      systemPrompt: "sys",
      tools: [],
      model: "test-model",
      apiKey: "key",
      session: [{ role: "user", content: [{ type: "text", text: "count" }] }],
    });

    const texts = (messages: Message[]) =>
      messages
        .filter((message) => message.role === "assistant")
        .flatMap((message) => message.content)
        .map((block) => (block.type === "text" ? block.text : ""));
    expect(texts(requests[1] ?? [])).toEqual(["one\ntwo"]);
    expect(texts(result.messages)).toEqual(["one\ntwo", "three\nfour"]);
  });

  test("a reply that stays cut at the output limit ends as a turn error, not as a normal end", async () => {
    let requests = 0;
    const adapter: ProviderAdapter = {
      family: "fake",
      async *stream(): AsyncIterable<StreamEvent> {
        requests += 1;
        yield { type: "text_delta", text: "more\nand mo" };
        yield { type: "message_stop", stopReason: "max_tokens", usage: { inputTokens: 1, outputTokens: 1 } };
      },
    };
    const result = await runTurn(adapter, new Scheduler(), noopHttp, {
      identity: user,
      capabilities: FULL_CAPABILITIES,
      systemPrompt: "sys",
      tools: [],
      model: "test-model",
      apiKey: "key",
      session: [{ role: "user", content: [{ type: "text", text: "write a long answer" }] }],
    });

    expect(requests).toBe(4);
    expect(result.stopReason).toBe("max_tokens");
    expect(result.error?.code).toBe("max_tokens");
    // The last part is the end of the output, so its half line stays.
    const last = result.messages.at(-1)?.content.at(-1);
    expect(last).toMatchObject({ type: "text", text: "more\nand mo" });
  });

  test("a complete tool call in a reply that the output limit cut still runs", async () => {
    // Measured with a real server: a full bash call arrived with finish reason "length", four times in a row.
    let runs = 0;
    const count: ToolSpec = {
      name: "count",
      description: "counts its own runs",
      inputSchema: {},
      riskTier: "safe",
      handler: async () => {
        runs += 1;
        return { content: `run ${runs}` };
      },
    };
    const adapter: ProviderAdapter = {
      family: "fake",
      async *stream(request): AsyncIterable<StreamEvent> {
        if (request.messages.some((m) => m.content.some((b) => b.type === "tool_result"))) {
          yield { type: "text_delta", text: "done" };
          yield { type: "message_stop", stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1 } };
          return;
        }
        yield { type: "tool_call_start", id: "c1", name: "count" };
        yield { type: "tool_call_delta", id: "c1", inputJsonDelta: "{}" };
        yield { type: "tool_call_end", id: "c1" };
        yield { type: "message_stop", stopReason: "max_tokens", usage: { inputTokens: 1, outputTokens: 1 } };
      },
    };
    const result = await runTurn(adapter, new Scheduler(), noopHttp, {
      identity: user,
      capabilities: FULL_CAPABILITIES,
      systemPrompt: "sys",
      tools: [count],
      model: "test-model",
      apiKey: "key",
      session: [{ role: "user", content: [{ type: "text", text: "count once" }] }],
    });

    expect(runs).toBe(1);
    expect(result.stopReason).toBe("end_turn");
    expect(result.error).toBeUndefined();
  });

  test("a tool call that the output limit cut in the middle gets a result that names the limit", async () => {
    // Measured with a real model: with only "not valid JSON" as the result, it sent the same cut call about 20 times.
    const adapter: ProviderAdapter = {
      family: "fake",
      async *stream(request): AsyncIterable<StreamEvent> {
        if (request.messages.some((m) => m.content.some((b) => b.type === "tool_result"))) {
          yield { type: "text_delta", text: "done" };
          yield { type: "message_stop", stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1 } };
          return;
        }
        yield { type: "tool_call_start", id: "c1", name: "write" };
        yield { type: "tool_call_delta", id: "c1", inputJsonDelta: '{"path": "out.txt", "content": "1 2 3' };
        yield { type: "tool_call_end", id: "c1" };
        yield { type: "message_stop", stopReason: "max_tokens", usage: { inputTokens: 1, outputTokens: 1 } };
      },
    };
    const result = await runTurn(adapter, new Scheduler(), noopHttp, {
      identity: user,
      capabilities: FULL_CAPABILITIES,
      systemPrompt: "sys",
      tools: [],
      model: "test-model",
      apiKey: "key",
      session: [{ role: "user", content: [{ type: "text", text: "write the file" }] }],
    });

    const toolResult = result.messages.flatMap((m) => m.content).find((b) => b.type === "tool_result");
    expect(toolResult).toMatchObject({ isError: true, content: expect.stringContaining("output limit") });
  });

  test("a reply that is cut before any text is not continued: there is nothing to go on from", async () => {
    // Measured with a reasoning model and a 40-token limit: each request used the limit for thinking only.
    let requests = 0;
    const adapter: ProviderAdapter = {
      family: "fake",
      async *stream(): AsyncIterable<StreamEvent> {
        requests += 1;
        yield { type: "thinking_delta", text: "let me think" };
        yield { type: "message_stop", stopReason: "max_tokens", usage: { inputTokens: 1, outputTokens: 1 } };
      },
    };
    const result = await runTurn(adapter, new Scheduler(), noopHttp, {
      identity: user,
      capabilities: FULL_CAPABILITIES,
      systemPrompt: "sys",
      tools: [],
      model: "test-model",
      apiKey: "key",
      session: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      maxTokensPerRequest: 40,
    });

    expect(requests).toBe(1);
    expect(result.error?.code).toBe("max_tokens");
    // The message names the limit and the setting, because a second run with the same limit ends the same way.
    expect(result.error?.message).toContain("40 tokens");
    expect(result.error?.message).toContain("maxOutputTokens");
  });

  test("a reply with no text is a turn error, and no empty message enters the transcript", async () => {
    const silent: ProviderAdapter = {
      family: "fake",
      async *stream(): AsyncIterable<StreamEvent> {
        yield { type: "message_stop", stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 0 } };
      },
    };
    const result = await runTurn(silent, new Scheduler(), noopHttp, {
      identity: user,
      capabilities: FULL_CAPABILITIES,
      systemPrompt: "sys",
      tools: [],
      model: "test-model",
      apiKey: "key",
      session: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    });

    expect(result.stopReason).toBe("end_turn");
    expect(result.error?.code).toBe("empty_response");
    // Strict providers reject a message with no content, so one such message would break the session.
    expect(result.messages.filter((message) => message.content.length === 0)).toEqual([]);
  });

  test("a reply that the provider ended with an error is a turn error, also when it has text", async () => {
    const broken: ProviderAdapter = {
      family: "fake",
      async *stream(): AsyncIterable<StreamEvent> {
        yield { type: "text_delta", text: "half an ans" };
        yield { type: "message_stop", stopReason: "error", usage: { inputTokens: 1, outputTokens: 3 } };
      },
    };
    const result = await runTurn(broken, new Scheduler(), noopHttp, {
      identity: user,
      capabilities: FULL_CAPABILITIES,
      systemPrompt: "sys",
      tools: [],
      model: "test-model",
      apiKey: "key",
      session: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    });

    expect(result.stopReason).toBe("error");
    expect(result.error?.code).toBe("provider_stop");
  });

  test("a tool result carrying images lands on the tool_result block and the event", async () => {
    const image = { type: "image" as const, mimeType: "image/png", data: "aGk=" };
    const events: unknown[] = [];
    const spec: ToolSpec = {
      name: "read",
      description: "reads",
      inputSchema: {},
      handler: async () => ({ content: "attached", images: [image] }),
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
      onEvent: (e) => events.push(e),
    });

    const toolResult = result.messages[1]!.content[0] as {
      type: string;
      content: string;
      images?: unknown[];
    };
    expect(toolResult.images).toEqual([image]);
    const event = events.find((e) => (e as { type: string }).type === "tool_result") as {
      images?: unknown[];
    };
    expect(event.images).toEqual([image]);
  });

  test("a text-only tool result carries no images key", async () => {
    const spec: ToolSpec = {
      name: "read",
      description: "reads",
      inputSchema: {},
      handler: async () => ({ content: "plain" }),
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
    });

    const toolResult = result.messages[1]!.content[0] as { images?: unknown[] };
    expect("images" in toolResult).toBe(false);
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

  test("an oversized tool result is truncated before it enters the conversation", async () => {
    const spec: ToolSpec = {
      name: "dump",
      description: "dumps far more than the cap",
      inputSchema: {},
      handler: async () => ({ content: "z".repeat(60_000) }),
    };

    const scheduler = new Scheduler();
    const result = await runTurn(toolThenDoneAdapter("dump", {}), scheduler, noopHttp, {
      identity: user,
      capabilities: FULL_CAPABILITIES,
      systemPrompt: "sys",
      tools: [spec],
      model: "test-model",
      apiKey: "key",
      session: [],
    });

    const toolResult = result.messages[1]!.content[0] as { type: string; content: string };
    expect(toolResult.type).toBe("tool_result");
    expect(toolResult.content).toContain("[Output truncated at 50000 bytes]");
    expect(toolResult.content.length).toBeLessThan(60_000);
  });

  test("a thinking signature attaches to the trailing thinking block", async () => {
    const adapter: ProviderAdapter = {
      family: "fake",
      async *stream(): AsyncIterable<StreamEvent> {
        yield { type: "thinking_delta", text: "reasoning here" };
        yield { type: "thinking_signature", signature: "sig-1" };
        yield { type: "text_delta", text: "answer" };
        yield { type: "message_stop", stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1 } };
      },
    };

    const result = await runTurn(adapter, new Scheduler(), noopHttp, {
      identity: user,
      capabilities: FULL_CAPABILITIES,
      systemPrompt: "sys",
      tools: [],
      model: "test-model",
      apiKey: "key",
      session: [],
    });

    expect(result.messages[0]?.content).toEqual([
      { type: "thinking", text: "reasoning here", signature: "sig-1", family: "fake" },
      { type: "text", text: "answer" },
    ]);
  });

  test("a signature with no preceding thinking creates its own block, and redacted_thinking passes through", async () => {
    const adapter: ProviderAdapter = {
      family: "fake",
      async *stream(): AsyncIterable<StreamEvent> {
        yield { type: "redacted_thinking", data: "enc-1" };
        yield { type: "thinking_signature", signature: "orphan-sig" };
        yield { type: "text_delta", text: "ok" };
        yield { type: "message_stop", stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1 } };
      },
    };

    const result = await runTurn(adapter, new Scheduler(), noopHttp, {
      identity: user,
      capabilities: FULL_CAPABILITIES,
      systemPrompt: "sys",
      tools: [],
      model: "test-model",
      apiKey: "key",
      session: [],
    });

    expect(result.messages[0]?.content).toEqual([
      { type: "redacted_thinking", data: "enc-1" },
      { type: "thinking", text: "", signature: "orphan-sig", family: "fake" },
      { type: "text", text: "ok" },
    ]);
  });

  test("two back-to-back signed thinking blocks keep separate signatures", async () => {
    const adapter: ProviderAdapter = {
      family: "fake",
      async *stream(): AsyncIterable<StreamEvent> {
        yield { type: "thinking_delta", text: "first reasoning" };
        yield { type: "thinking_signature", signature: "sig-1" };
        yield { type: "thinking_delta", text: "second reasoning" };
        yield { type: "thinking_signature", signature: "sig-2" };
        yield { type: "text_delta", text: "answer" };
        yield { type: "message_stop", stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1 } };
      },
    };

    const result = await runTurn(adapter, new Scheduler(), noopHttp, {
      identity: user,
      capabilities: FULL_CAPABILITIES,
      systemPrompt: "sys",
      tools: [],
      model: "test-model",
      apiKey: "key",
      session: [],
    });

    expect(result.messages[0]?.content).toEqual([
      { type: "thinking", text: "first reasoning", signature: "sig-1", family: "fake" },
      { type: "thinking", text: "second reasoning", signature: "sig-2", family: "fake" },
      { type: "text", text: "answer" },
    ]);
  });

  test("tool handlers receive the run's turnId in their context", async () => {
    let sawTurnId: string | undefined;
    const spec: ToolSpec = {
      name: "spy",
      description: "records ctx",
      inputSchema: {},
      handler: async (_input, ctx) => {
        sawTurnId = ctx.turnId;
        return { content: "ok" };
      },
    };

    await runTurn(toolThenDoneAdapter("spy", {}), new Scheduler(), noopHttp, {
      identity: user,
      capabilities: FULL_CAPABILITIES,
      systemPrompt: "sys",
      tools: [spec],
      model: "test-model",
      apiKey: "key",
      session: [],
      turnId: "turn-abc",
    });

    expect(sawTurnId).toBe("turn-abc");
  });

  test("mid-stream failure after content salvages the turn with an error stop reason", async () => {
    const adapter: ProviderAdapter = {
      family: "fake",
      async *stream(): AsyncIterable<StreamEvent> {
        yield { type: "text_delta", text: "partial" };
        throw new Error("connection reset");
      },
    };

    const result = await runTurn(adapter, new Scheduler(), noopHttp, {
      identity: user,
      capabilities: FULL_CAPABILITIES,
      systemPrompt: "sys",
      tools: [],
      model: "test-model",
      apiKey: "key",
      session: [],
    });

    expect(result.stopReason).toBe("error");
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]).toEqual({ role: "assistant", content: [{ type: "text", text: "partial" }] });
  });

  test("mid-stream failure reports its cause as an event and in the result", async () => {
    const adapter: ProviderAdapter = {
      family: "fake",
      async *stream(): AsyncIterable<StreamEvent> {
        yield { type: "text_delta", text: "partial" };
        throw new Error("connection reset");
      },
    };
    const errors: string[] = [];

    const result = await runTurn(adapter, new Scheduler(), noopHttp, {
      identity: user,
      capabilities: FULL_CAPABILITIES,
      systemPrompt: "sys",
      tools: [],
      model: "test-model",
      apiKey: "key",
      session: [],
      onEvent: (event) => {
        if (event.type === "error") errors.push(event.message);
      },
    });

    expect(errors).toEqual(["connection reset"]);
    expect(result.error).toEqual({ code: "network", message: "connection reset" });
  });

  test.each([
    ["before any content", false],
    ["after partial content", true],
  ])(
    "a provider stream that goes silent ends as a network error, %s",
    async (_name, partial) => {
      const adapter: ProviderAdapter = {
        family: "fake",
        async *stream(req: { signal?: AbortSignal }): AsyncIterable<StreamEvent> {
          if (partial) yield { type: "text_delta", text: "partial" };
          await new Promise((_resolve, reject) =>
            req.signal?.addEventListener("abort", () =>
              reject(new DOMException("The operation was aborted.", "AbortError")),
            ),
          );
        },
      };

      const turn = runTurn(adapter, new Scheduler({ maxAttempts: 1 }), noopHttp, {
        identity: user,
        capabilities: FULL_CAPABILITIES,
        systemPrompt: "sys",
        tools: [],
        model: "test-model",
        apiKey: "key",
        session: [],
        streamIdleMs: 50,
      });

      if (partial) {
        const result = await turn;
        expect(result.stopReason).toBe("error");
        expect(result.error).toEqual({ code: "network", message: "the provider sent nothing for 0.05 s" });
      } else {
        await expect(turn).rejects.toMatchObject({
          code: "network",
          message: "the provider sent nothing for 0.05 s",
        });
      }
    },
    5_000,
  );

  test("the idle limit of the adapter applies when the turn sets none", async () => {
    const adapter: ProviderAdapter = {
      family: "fake",
      streamIdleMs: 50,
      async *stream(req: { signal?: AbortSignal }): AsyncIterable<StreamEvent> {
        await new Promise((_resolve, reject) =>
          req.signal?.addEventListener("abort", () =>
            reject(new DOMException("The operation was aborted.", "AbortError")),
          ),
        );
      },
    };

    const turn = runTurn(adapter, new Scheduler({ maxAttempts: 1 }), noopHttp, {
      identity: user,
      capabilities: FULL_CAPABILITIES,
      systemPrompt: "sys",
      tools: [],
      model: "test-model",
      apiKey: "key",
      session: [],
    });

    await expect(turn).rejects.toMatchObject({ message: "the provider sent nothing for 0.05 s" });
  }, 5_000);

  test("onMessage reports each message as the turn produces it, before the next model call", async () => {
    const seen: string[] = [];
    let seenAtSecondCall: string[] = [];
    let calls = 0;
    const adapter: ProviderAdapter = {
      family: "fake",
      async *stream(): AsyncIterable<StreamEvent> {
        calls += 1;
        if (calls === 1) {
          yield { type: "tool_call_start", id: "call_1", name: "missing" };
          yield { type: "tool_call_end", id: "call_1" };
          yield { type: "message_stop", stopReason: "tool_use", usage: { inputTokens: 1, outputTokens: 1 } };
          return;
        }
        seenAtSecondCall = [...seen];
        yield { type: "text_delta", text: "done" };
        yield { type: "message_stop", stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1 } };
      },
    };

    await runTurn(adapter, new Scheduler(), noopHttp, {
      identity: user,
      capabilities: FULL_CAPABILITIES,
      systemPrompt: "sys",
      tools: [],
      model: "test-model",
      apiKey: "key",
      session: [{ role: "user", content: [{ type: "text", text: "go" }] }],
      onMessage: async (message) => {
        await Promise.resolve();
        seen.push(`${message.role}:${message.content.map((block) => block.type).join("+")}`);
      },
    });

    expect(seenAtSecondCall).toEqual(["assistant:tool_call", "user:tool_result"]);
    expect(seen).toEqual(["assistant:tool_call", "user:tool_result", "assistant:text"]);
  });

  test.each([
    ["before any content", false],
    ["after partial content", true],
  ])("a cancel during the model call ends the turn as cancelled, %s", async (_name, partial) => {
    const caller = new AbortController();
    let calls = 0;
    const adapter: ProviderAdapter = {
      family: "fake",
      async *stream(): AsyncIterable<StreamEvent> {
        calls += 1;
        if (partial) yield { type: "text_delta", text: "partial" };
        caller.abort();
        throw new DOMException("The operation was aborted.", "AbortError");
      },
    };
    const errors: string[] = [];

    const result = await runTurn(adapter, new Scheduler(), noopHttp, {
      identity: user,
      capabilities: FULL_CAPABILITIES,
      systemPrompt: "sys",
      tools: [],
      model: "test-model",
      apiKey: "key",
      session: [],
      signal: caller.signal,
      onEvent: (event) => {
        if (event.type === "error") errors.push(event.message);
      },
    });

    expect(result.stopReason).toBe("cancelled");
    expect(result.error).toBeUndefined();
    expect(errors).toEqual([]);
    expect(calls).toBe(1);
    expect(result.messages.map((m) => m.role)).toEqual(partial ? ["assistant"] : []);
  });

  test.each([
    ["the stream dies inside the call", undefined],
    ["the output limit cuts the turn", "max_tokens" as const],
  ])("a tool call gets an error result when %s", async (_name, stopReason) => {
    const adapter: ProviderAdapter = {
      family: "fake",
      async *stream(request): AsyncIterable<StreamEvent> {
        // A call in a cut reply runs, so a second request comes with its result: the model ends the turn there.
        if (request.messages.some((m) => m.content.some((b) => b.type === "tool_result"))) {
          yield { type: "text_delta", text: "done" };
          yield { type: "message_stop", stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1 } };
          return;
        }
        yield { type: "tool_call_start", id: "call_1", name: "read" };
        if (stopReason === undefined) throw new Error("connection reset");
        yield { type: "tool_call_end", id: "call_1" };
        yield { type: "message_stop", stopReason, usage: { inputTokens: 1, outputTokens: 1 } };
      },
    };

    const result = await runTurn(adapter, new Scheduler(), noopHttp, {
      identity: user,
      capabilities: FULL_CAPABILITIES,
      systemPrompt: "sys",
      tools: [],
      model: "test-model",
      apiKey: "key",
      session: [],
    });

    expect(result.messages.slice(0, 2).map((m) => m.role)).toEqual(["assistant", "user"]);
    expect(result.messages[1]?.content).toMatchObject([
      { type: "tool_result", toolCallId: "call_1", isError: true },
    ]);
  });
});

describe("U7: cheap-model routing", () => {
  function modelCapturingAdapter(seen: string[]): ProviderAdapter {
    return {
      family: "fake",
      async *stream(req: { model: string }): AsyncIterable<StreamEvent> {
        seen.push(req.model);
        yield { type: "text_delta", text: "ok" };
        yield { type: "message_stop", stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1 } };
      },
    };
  }

  async function baseOptions(extra: Record<string, unknown>) {
    return {
      identity: user,
      capabilities: FULL_CAPABILITIES,
      systemPrompt: "sys",
      tools: [],
      model: "primary-m",
      apiKey: "key",
      session: [],
      ...extra,
    };
  }

  test("eligible taskKind routes to the cheap model with a tag, no silent downgrade", async () => {
    const seen: string[] = [];
    const events: Array<{ type: string; routed?: string; tag?: string }> = [];
    const scheduler = new Scheduler();
    await runTurn(modelCapturingAdapter(seen), scheduler, noopHttp, {
      ...(await baseOptions({ taskKind: "summary", cheapModel: "cheap-m" })),
      onEvent: (e) => events.push(e as { type: string; routed?: string; tag?: string }),
    });

    expect(seen).toEqual(["cheap-m"]);
    const routes = events.filter((e) => e.type === "model_route");
    expect(routes.length).toBeGreaterThan(0);
    expect(routes[0]?.routed).toBe("cheap");
    expect(routes[0]?.tag).toContain("cheap");
  });

  test("ineligible taskKind stays on primary", async () => {
    const seen: string[] = [];
    const scheduler = new Scheduler();
    await runTurn(modelCapturingAdapter(seen), scheduler, noopHttp, {
      ...(await baseOptions({ taskKind: "code", cheapModel: "cheap-m" })),
    });

    expect(seen).toEqual(["primary-m"]);
  });

  test("explicit override always wins", async () => {
    const seen: string[] = [];
    const scheduler = new Scheduler();
    await runTurn(modelCapturingAdapter(seen), scheduler, noopHttp, {
      ...(await baseOptions({ taskKind: "summary", cheapModel: "cheap-m", forcePrimary: true })),
    });

    expect(seen).toEqual(["primary-m"]);
  });

  test("cheap failure falls back to primary", async () => {
    const seen: string[] = [];
    const adapter: ProviderAdapter = {
      family: "fake",
      async *stream(req: { model: string }): AsyncIterable<StreamEvent> {
        seen.push(req.model);
        if (req.model === "cheap-m") throw new Error("cheap down");
        yield { type: "text_delta", text: "recovered" };
        yield { type: "message_stop", stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1 } };
      },
    };
    const events: Array<{ type: string; routed?: string; tag?: string }> = [];
    const scheduler = new Scheduler();
    const result = await runTurn(adapter, scheduler, noopHttp, {
      ...(await baseOptions({ taskKind: "title", cheapModel: "cheap-m" })),
      onEvent: (e) => events.push(e as { type: string; routed?: string; tag?: string }),
    });

    expect(seen).toEqual(["cheap-m", "primary-m"]);
    expect(result.stopReason).toBe("end_turn");
    const routes = events.filter((e) => e.type === "model_route");
    expect(routes.some((r) => r.routed === "cheap")).toBe(true);
    expect(routes.some((r) => r.tag?.includes("fallback"))).toBe(true);
  });
});

describe("A5: input validation and permissions gating", () => {
  const user = { type: "user" as const };

  test("malformed tool input produces a clean per-call error, not a handler invocation or crash", async () => {
    let handlerRan = false;
    const spec: ToolSpec = {
      name: "read",
      description: "reads a file",
      inputSchema: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
      },
      handler: async () => {
        handlerRan = true;
        return { content: "should not get here" };
      },
    };

    const result = await runTurn(toolThenDoneAdapter("read", { path: 123 }), new Scheduler(), noopHttp, {
      identity: user,
      capabilities: FULL_CAPABILITIES,
      systemPrompt: "sys",
      tools: [spec],
      model: "m",
      apiKey: "k",
      session: [],
    });

    expect(handlerRan).toBe(false);
    expect(result.stopReason).toBe("end_turn");
    const toolResult = result.messages[1]?.content[0];
    expect(toolResult).toMatchObject({ type: "tool_result", isError: true });
    if (toolResult?.type === "tool_result") {
      expect(toolResult.content).toContain('invalid input: "path" must be string, got number');
    }
  });

  test("missing required properties and bad enums are caught with actionable messages", async () => {
    const schema = {
      type: "object",
      properties: { mode: { type: "string", enum: ["fast", "slow"] } },
      required: ["mode"],
    };
    expect(validateToolInput(schema, {})).toContain('missing required property "mode"');
    expect(validateToolInput(schema, { mode: "sideways" })).toContain("must be one of");
    expect(validateToolInput(schema, { mode: "fast" })).toBeUndefined();
    expect(validateToolInput({}, { anything: 1 })).toBeUndefined();
  });

  test("validateToolInput rejects array items with wrong type", () => {
    const schema = {
      type: "object",
      properties: {
        tags: { type: "array", items: { type: "string" } },
        scores: { type: "array", items: { type: "number" } },
      },
    };
    expect(validateToolInput(schema, { tags: ["a", "b", 1] })).toContain(
      '"tags[2]" must be string, got number',
    );
    expect(validateToolInput(schema, { tags: ["a", "b"] })).toBeUndefined();
    expect(validateToolInput(schema, { scores: [1, 2, "three"] })).toContain(
      '"scores[2]" must be number, got string',
    );
    expect(validateToolInput(schema, { scores: [1, 2, 3] })).toBeUndefined();
  });

  test("validateToolInput handles edge cases: null input, null schema, non-object root", () => {
    expect(validateToolInput({ type: "object", properties: { x: { type: "string" } } }, null)).toContain(
      "expected an object, got null",
    );
    expect(validateToolInput({ type: "object", properties: { x: { type: "string" } } }, "string")).toContain(
      "expected an object, got string",
    );
    expect(validateToolInput({ type: "object", properties: { x: { type: "string" } } }, [])).toContain(
      "expected an object, got array",
    );
    expect(validateToolInput(null as unknown as Record<string, unknown>, { x: 1 })).toBeUndefined();
    expect(validateToolInput({}, null)).toBeUndefined();
  });

  test("validateToolInput passes valid input through cleanly", () => {
    const schema = {
      type: "object",
      properties: {
        name: { type: "string" },
        age: { type: "integer" },
        active: { type: "boolean" },
        tags: { type: "array", items: { type: "string" } },
        meta: { type: "object" },
        score: { type: "number" },
      },
      required: ["name", "age"],
    };
    expect(
      validateToolInput(schema, {
        name: "alice",
        age: 30,
        active: true,
        tags: ["dev", "ops"],
        meta: { key: "val" },
        score: 9.5,
      }),
    ).toBeUndefined();
  });

  test("a deny decision blocks the handler with a clean permission error", async () => {
    let handlerRan = false;
    const spec: ToolSpec = {
      name: "bash",
      description: "runs a command",
      inputSchema: { type: "object", properties: { command: { type: "string" } } },
      riskTier: "dangerous",
      handler: async () => {
        handlerRan = true;
        return { content: "ran" };
      },
    };
    const toolPolicy = {
      check: async () => "deny" as const,
    };

    const result = await runTurn(
      toolThenDoneAdapter("bash", { command: "rm -rf /" }),
      new Scheduler(),
      noopHttp,
      {
        identity: user,
        capabilities: FULL_CAPABILITIES,
        systemPrompt: "sys",
        tools: [spec],
        model: "m",
        apiKey: "k",
        session: [],
        toolPolicy,
      },
    );

    expect(handlerRan).toBe(false);
    const toolResult = result.messages[1]?.content[0];
    if (toolResult?.type === "tool_result") {
      expect(toolResult.content).toContain("permission denied");
      // Without this sentence a weaker model sent the refused call again, 15 times on average in live runs.
      expect(toolResult.content).toContain("Do not call it again");
      expect(toolResult.isError).toBe(true);
    }
  });

  test("an ask decision routes through requestApproval; once runs, reject refuses", async () => {
    const spec: ToolSpec = {
      name: "bash",
      description: "runs a command",
      inputSchema: { type: "object", properties: { command: { type: "string" } } },
      riskTier: "dangerous",
      handler: async (_input, ctx) => ({ content: `ran with ${ctx.toolCallId}` }),
    };
    const toolPolicy = {
      check: async (
        _request: unknown,
        ask: ((r: { tool: string; title: string }) => Promise<"once" | "always" | "reject">) | undefined,
      ) =>
        (await ask?.({ tool: "bash", title: "cmd" })) === "reject" ? ("deny" as const) : ("allow" as const),
    };
    const decisions: Array<"once" | "reject"> = ["once", "reject"];
    let decisionIndex = 0;

    const result = await runTurn(
      toolThenDoneAdapter("bash", { command: "bun test" }),
      new Scheduler(),
      noopHttp,
      {
        identity: user,
        capabilities: FULL_CAPABILITIES,
        systemPrompt: "sys",
        tools: [spec],
        model: "m",
        apiKey: "k",
        session: [],
        toolPolicy,
        requestApproval: async () => decisions[decisionIndex++] ?? "reject",
      },
    );

    const toolResult = result.messages[1]?.content[0];
    if (toolResult?.type === "tool_result") {
      expect(toolResult.isError).toBe(false);
      expect(toolResult.content).toContain("ran with call_1");
    }
    expect(decisionIndex).toBe(1);
  });

  test("tool contexts carry cwd, sessionId, toolCallId, and the approval callback", async () => {
    const spec: ToolSpec = {
      name: "read",
      description: "reads a file",
      inputSchema: { type: "object", properties: { path: { type: "string" } } },
      handler: async (_input, ctx) => ({
        content: `${ctx.cwd}|${ctx.sessionId}|${ctx.toolCallId}|${typeof ctx.requestApproval}|${ctx.turnId}`,
      }),
    };

    const result = await runTurn(toolThenDoneAdapter("read", { path: "a.ts" }), new Scheduler(), noopHttp, {
      identity: user,
      capabilities: FULL_CAPABILITIES,
      systemPrompt: "sys",
      tools: [spec],
      model: "m",
      apiKey: "k",
      session: [],
      turnId: "turn-9",
      sessionId: "ses-1",
      cwd: "/repo",
      requestApproval: async () => "once",
    });

    const toolResult = result.messages[1]?.content[0];
    if (toolResult?.type === "tool_result") {
      expect(toolResult.content).toBe("/repo|ses-1|call_1|function|turn-9");
    }
  });

  test("tool contexts carry the agent handle from an agent turn identity", async () => {
    const spec: ToolSpec = {
      name: "read",
      description: "reads a file",
      inputSchema: { type: "object", properties: { path: { type: "string" } } },
      handler: async (_input, ctx) => ({ content: `handle=${ctx.agentHandle ?? "none"}` }),
    };

    const agentResult = await runTurn(
      toolThenDoneAdapter("read", { path: "a.ts" }),
      new Scheduler(),
      noopHttp,
      {
        identity: { type: "agent", name: "coder" },
        capabilities: FULL_CAPABILITIES,
        systemPrompt: "sys",
        tools: [spec],
        model: "m",
        apiKey: "k",
        session: [],
      },
    );
    const agentToolResult = agentResult.messages[1]?.content[0];
    if (agentToolResult?.type === "tool_result") {
      expect(agentToolResult.content).toBe("handle=coder");
    } else {
      expect.unreachable("expected a tool_result message");
    }

    const userResult = await runTurn(
      toolThenDoneAdapter("read", { path: "a.ts" }),
      new Scheduler(),
      noopHttp,
      {
        identity: user,
        capabilities: FULL_CAPABILITIES,
        systemPrompt: "sys",
        tools: [spec],
        model: "m",
        apiKey: "k",
        session: [],
      },
    );
    const userToolResult = userResult.messages[1]?.content[0];
    if (userToolResult?.type === "tool_result") {
      expect(userToolResult.content).toBe("handle=none");
    } else {
      expect.unreachable("expected a tool_result message");
    }
  });
});
