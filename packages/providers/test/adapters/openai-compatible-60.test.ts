import { describe, expect, test } from "bun:test";
import type { HttpClient } from "@agency/net";
import { createOpenAiCompatibleAdapter } from "../../src/adapters/openai-compatible.ts";
import type { ProviderRequest, StreamEvent } from "../../src/types.ts";

const baseRequest: ProviderRequest = {
  model: "llama3.3",
  apiKey: "unused",
  messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
  maxTokens: 256,
};

async function collect(events: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
}

function sseHttp(frames: string[]): HttpClient {
  const encoder = new TextEncoder();
  return {
    fetch: async () =>
      new Response(
        new ReadableStream({
          start(c) {
            for (const f of frames) c.enqueue(encoder.encode(`data: ${f}\n\n`));
            c.enqueue(encoder.encode("data: [DONE]\n\n"));
            c.close();
          },
        }),
        { status: 200 },
      ),
  };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

describe("item 60: legacy function_call gaps", () => {
  test("coalesced tool_calls delta (id+name+args in one frame) emits start AND delta", async () => {
    const adapter = createOpenAiCompatibleAdapter("openai", "https://api.openai.com/v1");
    const frame = JSON.stringify({
      choices: [
        {
          delta: {
            tool_calls: [{ index: 0, id: "call_1", function: { name: "read", arguments: '{"path":"a"}' } }],
          },
          finish_reason: null,
        },
      ],
    });
    const done = JSON.stringify({ choices: [{ delta: {}, finish_reason: "tool_calls" }] });
    const events = await collect(adapter.stream(baseRequest, sseHttp([frame, done])));
    const starts = events.filter((e) => e.type === "tool_call_start");
    const deltas = events.filter((e) => e.type === "tool_call_delta");
    expect(starts).toHaveLength(1);
    expect(deltas).toHaveLength(1);
    expect(deltas[0]).toMatchObject({ id: "call_1", inputJsonDelta: '{"path":"a"}' });
  });

  test("coalesced legacy function_call (name+args in one frame) emits start AND delta with UUID id", async () => {
    const adapter = createOpenAiCompatibleAdapter("openai", "https://api.openai.com/v1");
    const frame = JSON.stringify({
      choices: [
        {
          delta: { function_call: { name: "grep", arguments: '{"pattern":"x"}' } },
          finish_reason: null,
        },
      ],
    });
    const done = JSON.stringify({ choices: [{ delta: {}, finish_reason: "function_call" }] });
    const events = await collect(adapter.stream(baseRequest, sseHttp([frame, done])));
    const starts = events.filter(
      (e): e is Extract<StreamEvent, { type: "tool_call_start" }> => e.type === "tool_call_start",
    );
    const deltas = events.filter(
      (e): e is Extract<StreamEvent, { type: "tool_call_delta" }> => e.type === "tool_call_delta",
    );
    const ends = events.filter((e) => e.type === "tool_call_end");
    expect(starts).toHaveLength(1);
    expect(starts[0]!.name).toBe("grep");
    expect(starts[0]!.id).toMatch(UUID_RE);
    expect(deltas).toHaveLength(1);
    expect(deltas[0]!.id).toBe(starts[0]!.id);
    expect(deltas[0]!.inputJsonDelta).toBe('{"pattern":"x"}');
    expect(ends).toHaveLength(1);
    expect(ends[0]).toMatchObject({ id: starts[0]!.id });
  });

  test("split legacy function_call assigns one UUID shared by delta and end", async () => {
    const adapter = createOpenAiCompatibleAdapter("openai", "https://api.openai.com/v1");
    const f1 = JSON.stringify({
      choices: [{ delta: { function_call: { name: "read_file" } }, finish_reason: null }],
    });
    const f2 = JSON.stringify({
      choices: [{ delta: { function_call: { arguments: '{"path":"b"}' } }, finish_reason: null }],
    });
    const done = JSON.stringify({ choices: [{ delta: {}, finish_reason: "function_call" }] });
    const events = await collect(adapter.stream(baseRequest, sseHttp([f1, f2, done])));
    const starts = events.filter(
      (e): e is Extract<StreamEvent, { type: "tool_call_start" }> => e.type === "tool_call_start",
    );
    expect(starts).toHaveLength(1);
    expect(starts[0]!.id).toMatch(UUID_RE);
    const ids = new Set(events.flatMap((e) => ("id" in e ? [(e as { id: string }).id] : [])));
    expect(ids.size).toBe(1);
  });
});
