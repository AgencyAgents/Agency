import { describe, expect, test } from "bun:test";
import { buildEnvironmentBlock, composeSystemPrompt, gatherEnvironmentInfo } from "@agency/core";
import type { HttpClient } from "@agency/net";
import { anthropicAdapter } from "../../src/adapters/anthropic.ts";
import { googleAdapter } from "../../src/adapters/google.ts";
import { createOpenAiCompatibleAdapter } from "../../src/adapters/openai-compatible.ts";
import { splitStableDynamic } from "../../src/cache-policy.ts";
import type { ProviderRequest, StreamEvent } from "../../src/types.ts";

function sseResponse(text: string, init?: ResponseInit): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(text));
      controller.close();
    },
  });
  return new Response(body, { status: 200, ...init });
}

async function collect(events: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
}

const IDENTITY = "IDENTITY";
const WORKSPACE = "workspace rules";
const pad = (s: string): string => s + "x".repeat(4200);

function minuteApartTurns() {
  const mk = (now: Date, status: string) => {
    const env = buildEnvironmentBlock(gatherEnvironmentInfo({ cwd: "/repo", now, git: () => status }));
    return composeSystemPrompt({
      base: IDENTITY,
      instructions: [WORKSPACE],
      toolDescriptions: ["tool: read"],
      context: env,
    });
  };
  const first = mk(new Date("2026-09-06T10:00:00"), "## main\n M a.ts\n");
  const second = mk(new Date("2026-09-06T10:01:00"), "## main\n M a.ts\n M b.ts\n");
  return { first, second };
}

function countMarkers(body: unknown): number {
  return JSON.stringify(body).split("cache_control").length - 1;
}

describe("prompt cache policy (7.0.7)", () => {
  test("minute-apart dirty-tree turns share a byte-identical cached prefix", () => {
    const { first, second } = minuteApartTurns();
    const stableOf = (c: { segments: { stability: string; text: string }[] }): string =>
      splitStableDynamic(
        c.segments.map((s) => ({ stability: s.stability as "shared" | "agent" | "dynamic", text: s.text })),
      ).stable;
    expect(stableOf(second)).toBe(stableOf(first));
    expect(second.text).not.toBe(first.text);
  });

  test("the second turn reports a cache read instead of a full write", async () => {
    const sse = sseResponse(
      [
        'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":1200,"cache_read_input_tokens":1100}}}\n\n',
        'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":7}}\n\n',
        'event: message_stop\ndata: {"type":"message_stop"}\n\n',
      ].join(""),
    );
    const events = await collect(
      anthropicAdapter.stream(
        {
          model: "m",
          apiKey: "k",
          messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
          maxTokens: 64,
        },
        { fetch: async () => sse },
      ),
    );
    expect(events.at(-1)).toMatchObject({
      type: "message_stop",
      usage: { inputTokens: 1200, outputTokens: 7, cachedInputTokens: 1100 },
    });
  });

  test("at most four markers in tools-system-messages order, 3 and 4 roll forward", async () => {
    const bodies: unknown[] = [];
    const http: HttpClient = {
      fetch: async (_url, init) => {
        bodies.push(JSON.parse(init?.body as string));
        return sseResponse("");
      },
    };
    const segments = (dynamic: string) => [
      { stability: "shared" as const, text: pad("shared prefix") },
      { stability: "agent" as const, text: pad("agent role") },
      { stability: "dynamic" as const, text: dynamic },
    ];
    const tools = [{ name: "read", description: pad("reads"), inputSchema: {} }];
    const u1 = { role: "user" as const, content: [{ type: "text" as const, text: pad("one") }] };
    const a1 = { role: "assistant" as const, content: [{ type: "text" as const, text: pad("ack") }] };
    const u2 = { role: "user" as const, content: [{ type: "text" as const, text: pad("two") }] };
    const a2 = { role: "assistant" as const, content: [{ type: "text" as const, text: pad("ack2") }] };
    const u3 = { role: "user" as const, content: [{ type: "text" as const, text: pad("three") }] };
    const req = (messages: ProviderRequest["messages"]): ProviderRequest => ({
      model: "m",
      apiKey: "k",
      systemSegments: segments("env"),
      tools,
      messages,
      maxTokens: 64,
    });
    await collect(anthropicAdapter.stream(req([u1]), http));
    await collect(anthropicAdapter.stream(req([u1, a1, u2]), http));
    await collect(anthropicAdapter.stream(req([u1, a1, u2, a2, u3]), http));

    for (const body of bodies) expect(countMarkers(body)).toBeLessThanOrEqual(4);
    const raw = bodies.map((b) => JSON.stringify(b));
    const orderOf = (s: string): number[] => {
      const idx: number[] = [];
      let i = s.indexOf("cache_control");
      while (i >= 0) {
        idx.push(i);
        i = s.indexOf("cache_control", i + 1);
      }
      return idx;
    };
    expect(orderOf(raw[1] as string)).toEqual([...orderOf(raw[1] as string)].sort((a, b) => a - b));
    const turn2 = bodies[1] as { messages: { content: { cache_control?: unknown }[] }[] };
    expect(turn2.messages[0]?.content.at(-1)).toMatchObject({ cache_control: { type: "ephemeral" } });
    expect(turn2.messages[2]?.content.at(-1)).toMatchObject({ cache_control: { type: "ephemeral" } });
    const turn3 = bodies[2] as { messages: { content: { cache_control?: unknown }[] }[] };
    expect(turn3.messages[0]?.content.at(-1)).not.toMatchObject({ cache_control: { type: "ephemeral" } });
    expect(turn3.messages[2]?.content.at(-1)).toMatchObject({ cache_control: { type: "ephemeral" } });
    expect(turn3.messages[4]?.content.at(-1)).toMatchObject({ cache_control: { type: "ephemeral" } });
  });

  test("two agents share the cached prefix and diverge only in role and tools", async () => {
    const bodies: unknown[] = [];
    const http: HttpClient = {
      fetch: async (_url, init) => {
        bodies.push(JSON.parse(init?.body as string));
        return sseResponse("");
      },
    };
    const mk = (role: string, tool: string): ProviderRequest => ({
      model: "m",
      apiKey: "k",
      systemSegments: [
        { stability: "shared", text: pad("team identity plus playbook") },
        { stability: "agent", text: pad(role) },
        { stability: "dynamic", text: "env" },
      ],
      tools: [{ name: tool, description: pad(`${tool} does things`), inputSchema: {} }],
      messages: [{ role: "user", content: [{ type: "text", text: pad("go") }] }],
      maxTokens: 64,
    });
    await collect(anthropicAdapter.stream(mk("coder role", "read"), http));
    await collect(anthropicAdapter.stream(mk("reviewer role", "grep"), http));
    const [a, b] = bodies as { system: { text: string }[] }[];
    const sharedBytes = `${pad("team identity plus playbook")}\n\n`;
    expect(a?.system[0]?.text.startsWith(sharedBytes)).toBe(true);
    expect(b?.system[0]?.text.startsWith(sharedBytes)).toBe(true);
    expect(a?.system[0]?.text).not.toBe(b?.system[0]?.text);
  });

  test("openai-compatible emits no markers while holding prefix stability", async () => {
    const bodies: unknown[] = [];
    const http: HttpClient = {
      fetch: async (_url, init) => {
        bodies.push(JSON.parse(init?.body as string));
        return new Response(
          new ReadableStream({
            start(c) {
              c.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
              c.close();
            },
          }),
          { status: 200 },
        );
      },
    };
    const adapter = createOpenAiCompatibleAdapter("test", "http://localhost:1/v1");
    const { first, second } = minuteApartTurns();
    for (const composed of [first, second]) {
      await collect(
        adapter.stream(
          {
            model: "m",
            apiKey: "k",
            system: composed.text,
            systemSegments: composed.segments,
            messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
            maxTokens: 64,
          },
          http,
        ),
      );
    }
    for (const body of bodies) expect(JSON.stringify(body)).not.toContain("cache_control");
    const [one, two] = bodies as { messages: { role: string; content: string }[] }[];
    expect(one?.messages[0]?.content).not.toBe(two?.messages[0]?.content);
  });

  test("google wires explicit CachedContent for the shared prefix", async () => {
    const calls: { url: string; body: unknown }[] = [];
    const sse = `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: "ok" }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 2 } })}\n\n`;
    const http: HttpClient = {
      fetch: async (url, init) => {
        const body = init?.body ? JSON.parse(init.body as string) : undefined;
        calls.push({ url, body });
        if (url.includes("/cachedContents"))
          return new Response(JSON.stringify({ name: "cachedContents/abc" }));
        const encoder = new TextEncoder();
        return new Response(
          new ReadableStream({
            start(c) {
              c.enqueue(encoder.encode(sse));
              c.close();
            },
          }),
          { status: 200 },
        );
      },
    };
    await collect(
      googleAdapter.stream(
        {
          model: "gemini-3-pro",
          apiKey: "k",
          systemSegments: [
            { stability: "shared", text: pad("team identity plus playbook") },
            { stability: "agent", text: pad("coder role") },
            { stability: "dynamic", text: "env" },
          ],
          messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
          maxTokens: 64,
        },
        http,
      ),
    );
    const create = calls.find((c) => c.url.includes("/cachedContents"));
    const generate = calls.find((c) => c.url.includes(":streamGenerateContent"));
    if (!create || !generate) throw new Error("expected both cachedContents and generate calls");
    expect(JSON.stringify((create.body as { systemInstruction: unknown }).systemInstruction)).toContain(
      "team identity plus playbook",
    );
    expect((create.body as { ttl: string }).ttl).toBe("3600s");
    expect((generate.body as { cachedContent: string }).cachedContent).toBe("cachedContents/abc");
    expect((generate.body as { tools: unknown }).tools).toBeUndefined();
  });
});
