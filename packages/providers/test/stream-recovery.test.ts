import { describe, expect, test } from "bun:test";
import { withMidStreamRecovery } from "../src/stream-recovery.ts";
import type { StreamEvent } from "../src/types.ts";

async function collect(events: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
}

async function* of(...events: StreamEvent[]): AsyncIterable<StreamEvent> {
  for (const event of events) yield event;
}

async function* boomAfter(...events: StreamEvent[]): AsyncIterable<StreamEvent> {
  for (const event of events) yield event;
  throw new Error("connection reset");
}

describe("withMidStreamRecovery", () => {
  test("passes a clean stream through untouched", async () => {
    const events: StreamEvent[] = [
      { type: "text_delta", text: "hi" },
      { type: "message_stop", stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1 } },
    ];
    expect(await collect(withMidStreamRecovery(of(...events)))).toEqual(events);
  });

  test("rethrows a failure before any content, so cheap retries still apply", async () => {
    await expect(collect(withMidStreamRecovery(boomAfter()))).rejects.toThrow("connection reset");
  });

  test("salvages a mid-stream drop: content stands, turn ends with stopReason error", async () => {
    const events = await collect(
      withMidStreamRecovery(
        boomAfter({ type: "thinking_delta", text: "hmm" }, { type: "text_delta", text: "partial answer" }),
      ),
    );

    expect(events).toEqual([
      { type: "thinking_delta", text: "hmm" },
      { type: "text_delta", text: "partial answer" },
      { type: "message_stop", stopReason: "error", usage: { inputTokens: 0, outputTokens: 0 } },
    ]);
  });

  test("swallows a failure after message_stop instead of salvaging a duplicate stop", async () => {
    const events = await collect(
      withMidStreamRecovery(
        boomAfter(
          {
            type: "text_delta",
            text: "done",
          },
          {
            type: "message_stop",
            stopReason: "end_turn",
            usage: { inputTokens: 3, outputTokens: 2 },
          },
        ),
      ),
    );
    expect(events).toHaveLength(2);
    expect(events.at(-1)).toMatchObject({ type: "message_stop", stopReason: "end_turn" });
  });

  test("synthesizes tool_call_end for dangling tool call on mid-stream drop", async () => {
    const events = await collect(
      withMidStreamRecovery(
        boomAfter(
          { type: "tool_call_start", id: "call_1", name: "read" },
          { type: "tool_call_delta", id: "call_1", inputJsonDelta: '{"path":' },
          { type: "text_delta", text: "Let me read that file" },
        ),
      ),
    );

    // Should see: tool_call_start, tool_call_delta, text_delta, tool_call_end, message_stop
    expect(events.length).toBe(5);
    expect(events[0]).toEqual({ type: "tool_call_start", id: "call_1", name: "read" });
    expect(events[1]).toEqual({ type: "tool_call_delta", id: "call_1", inputJsonDelta: '{"path":' });
    expect(events[2]).toEqual({ type: "text_delta", text: "Let me read that file" });
    expect(events[3]).toEqual({ type: "tool_call_end", id: "call_1" });
    expect(events[4]).toMatchObject({ type: "message_stop", stopReason: "error" });
  });

  test("synthesizes tool_call_end for multiple dangling tool calls", async () => {
    const events = await collect(
      withMidStreamRecovery(
        boomAfter(
          { type: "tool_call_start", id: "call_1", name: "read" },
          { type: "tool_call_start", id: "call_2", name: "grep" },
          { type: "tool_call_delta", id: "call_1", inputJsonDelta: '{"path":"src"}' },
        ),
      ),
    );

    // Both tool calls should get a tool_call_end
    const toolCallEnds = events.filter((e) => e.type === "tool_call_end");
    expect(toolCallEnds).toHaveLength(2);
    expect(toolCallEnds[0]).toEqual({ type: "tool_call_end", id: "call_1" });
    expect(toolCallEnds[1]).toEqual({ type: "tool_call_end", id: "call_2" });
    expect(events.at(-1)).toMatchObject({ type: "message_stop", stopReason: "error" });
  });

  test("does not synthesize tool_call_end for completed tool calls", async () => {
    const events = await collect(
      withMidStreamRecovery(
        boomAfter(
          { type: "tool_call_start", id: "call_1", name: "read" },
          { type: "tool_call_end", id: "call_1" },
          { type: "text_delta", text: "Done reading" },
        ),
      ),
    );

    // tool_call_1 was completed before the drop, so no extra tool_call_end
    const toolCallEnds = events.filter((e) => e.type === "tool_call_end");
    expect(toolCallEnds).toHaveLength(1);
    expect(toolCallEnds[0]).toEqual({ type: "tool_call_end", id: "call_1" });
    expect(events.at(-1)).toMatchObject({ type: "message_stop", stopReason: "error" });
  });
});
