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
});
