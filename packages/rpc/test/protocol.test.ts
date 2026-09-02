import { describe, expect, test } from "bun:test";
import { encodeFrame, FrameDecoder, matchesSubscription, PROTOCOL_VERSION } from "../src/protocol.ts";

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

  test("throws when a single completed frame exceeds the max size", () => {
    const decoder = new FrameDecoder(1024);
    expect(() => decoder.push(`"x":"${"a".repeat(2048)}"\n`)).toThrow(/frame exceeds maximum size/);
  });

  test("throws when an unterminated partial frame grows past the max size", () => {
    const decoder = new FrameDecoder(1024);
    expect(() => decoder.push("a".repeat(1025))).toThrow(/frame exceeds maximum size/);
  });

  test("the default max size accommodates large-but-legitimate frames", () => {
    const decoder = new FrameDecoder();
    const bigFrame = `${JSON.stringify({ type: "request", id: "x", method: "m", params: { blob: "y".repeat(1_000_000) } })}\n`;
    const messages = decoder.push(bigFrame);
    expect(messages).toHaveLength(1);
  });
});

describe("matchesSubscription", () => {
  test("an empty list matches every event", () => {
    expect(matchesSubscription([], "turn.abc")).toBe(true);
  });

  test("exact names match, and a bare turn id matches its turn.<id> events", () => {
    expect(matchesSubscription(["turn.abc"], "turn.abc")).toBe(true);
    expect(matchesSubscription(["turn.abc"], "turn.xyz")).toBe(false);
    expect(matchesSubscription(["abc"], "turn.abc")).toBe(true);
    expect(matchesSubscription(["abc"], "turn.abc.extra")).toBe(false);
  });
});
