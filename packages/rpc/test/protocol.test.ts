import { describe, expect, test } from "bun:test";
import { encodeFrame, FrameDecoder, PROTOCOL_VERSION } from "../src/protocol.ts";

describe("encodeFrame", () => {
  test("serializes a message with a trailing newline", () => {
    const frame = encodeFrame({ type: "hello", version: PROTOCOL_VERSION });
    expect(frame).toBe('{"type":"hello","version":1}\n');
  });
});

describe("FrameDecoder", () => {
  test("decodes a single complete frame", () => {
    const decoder = new FrameDecoder();
    const messages = decoder.push('{"type":"hello","version":1}\n');
    expect(messages).toEqual([{ type: "hello", version: 1 }]);
  });

  test("decodes multiple frames delivered in one chunk", () => {
    const decoder = new FrameDecoder();
    const messages = decoder.push(
      '{"type":"event","event":"a","payload":1}\n{"type":"event","event":"b","payload":2}\n',
    );
    expect(messages).toHaveLength(2);
    expect(messages[0]).toMatchObject({ event: "a" });
    expect(messages[1]).toMatchObject({ event: "b" });
  });

  test("buffers a frame split across two chunks", () => {
    const decoder = new FrameDecoder();
    expect(decoder.push('{"type":"event","event":"a",')).toEqual([]);
    const messages = decoder.push('"payload":1}\n');
    expect(messages).toEqual([{ type: "event", event: "a", payload: 1 }]);
  });

  test("ignores blank lines", () => {
    const decoder = new FrameDecoder();
    const messages = decoder.push('\n{"type":"event","event":"a","payload":1}\n\n');
    expect(messages).toHaveLength(1);
  });

  test("keeps an incomplete trailing frame buffered for the next push", () => {
    const decoder = new FrameDecoder();
    const first = decoder.push('{"type":"event","event":"a","payload":1}\n{"type":"eve');
    expect(first).toEqual([{ type: "event", event: "a", payload: 1 }]);

    const second = decoder.push('nt","event":"b","payload":2}\n');
    expect(second).toEqual([{ type: "event", event: "b", payload: 2 }]);
  });
});
