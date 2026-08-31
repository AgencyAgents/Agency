import { describe, expect, test } from "bun:test";
import { parseSse } from "../src/sse.ts";

function streamFrom(text: string): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(text));
      controller.close();
    },
  });
}

async function collect(stream: ReadableStream<Uint8Array>) {
  const events = [];
  for await (const event of parseSse(stream)) events.push(event);
  return events;
}

describe("parseSse", () => {
  test("parses a named event with single-line data", async () => {
    const events = await collect(streamFrom('event: message_start\ndata: {"id":"1"}\n\n'));
    expect(events).toEqual([{ event: "message_start", data: '{"id":"1"}' }]);
  });

  test("parses bare data-only events (OpenAI style)", async () => {
    const events = await collect(streamFrom('data: {"delta":"hi"}\n\ndata: [DONE]\n\n'));
    expect(events).toEqual([
      { event: undefined, data: '{"delta":"hi"}' },
      { event: undefined, data: "[DONE]" },
    ]);
  });

  test("joins multi-line data fields with newlines", async () => {
    const events = await collect(streamFrom("data: line one\ndata: line two\n\n"));
    expect(events).toEqual([{ event: undefined, data: "line one\nline two" }]);
  });

  test("handles a frame split across two chunks", async () => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"partial":'));
        controller.enqueue(encoder.encode('true}\n\n'));
        controller.close();
      },
    });
    const events = await collect(stream);
    expect(events).toEqual([{ event: undefined, data: '{"partial":true}' }]);
  });

  test("flushes a trailing frame with no terminating blank line", async () => {
    const events = await collect(streamFrom("data: trailing"));
    expect(events).toEqual([{ event: undefined, data: "trailing" }]);
  });

  test("ignores comment and blank keep-alive lines", async () => {
    const events = await collect(streamFrom(": keep-alive\n\ndata: real\n\n"));
    expect(events).toEqual([{ event: undefined, data: "real" }]);
  });
});
