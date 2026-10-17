import { describe, expect, test } from "bun:test";
import { FULL_CAPABILITIES } from "@agency/guard";
import type { HttpClient } from "@agency/net";
import type { ProviderAdapter, ProviderRequest, StreamEvent } from "@agency/providers";
import { Scheduler } from "@agency/providers";
import { AgencyError, ErrorCode, type Message } from "@agency/schema";
import { runTurn } from "../../src/loop.ts";
import { compactionPrompt } from "../../src/prompt/compaction.ts";
import { renderTranscript } from "../../src/sessions/compaction.ts";
import { modelSummarizer } from "../../src/sessions/summarize.ts";

const noopHttp: HttpClient = { fetch: async () => new Response() };
const usage = { inputTokens: 1, outputTokens: 1 };

const text = (role: Message["role"], value: string): Message => ({
  role,
  content: [{ type: "text", text: value }],
});

describe("renderTranscript", () => {
  test("keeps texts in full, tool inputs, and the start of each tool result", () => {
    const long = "y".repeat(5000);
    const rendered = renderTranscript([
      text("user", "Rename the helper in src/util.ts to parseRef. Do not touch the tests."),
      {
        role: "assistant",
        content: [
          { type: "thinking", text: "private reasoning" },
          { type: "text", text: "I will read the file first." },
          { type: "tool_call", id: "c1", name: "read", input: { path: "src/util.ts" } },
        ],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", toolCallId: "c1", content: `export const x = 1;${long}`, isError: false },
        ],
      },
    ]);
    expect(rendered).toContain("Rename the helper in src/util.ts to parseRef. Do not touch the tests.");
    expect(rendered).toContain("I will read the file first.");
    expect(rendered).toContain('read {"path":"src/util.ts"}');
    expect(rendered).toContain("export const x = 1;");
    expect(rendered).not.toContain("private reasoning");
    expect(rendered.length).toBeLessThan(2000);
  });
});

function fixedAdapter(reply: string | Error, seen: ProviderRequest[] = []): ProviderAdapter {
  return {
    family: "fake",
    async *stream(request): AsyncIterable<StreamEvent> {
      seen.push(request);
      if (reply instanceof Error) throw reply;
      if (reply) yield { type: "text_delta", text: reply };
      yield { type: "message_stop", stopReason: "end_turn", usage };
    },
  };
}

describe("modelSummarizer", () => {
  const transcript = "[user] first line\n[assistant] last line";
  const make = (adapter: ProviderAdapter) =>
    modelSummarizer({ adapter, http: noopHttp, model: "m", apiKey: "k" });

  test("the model writes the summary from the transcript, with the instructions as its system prompt", async () => {
    const seen: ProviderRequest[] = [];
    const summary = await make(fixedAdapter("  the model's summary  ", seen))(transcript, "INSTRUCTIONS");
    expect(summary).toBe("the model's summary");
    expect(seen[0]?.system).toBe("INSTRUCTIONS");
    expect(JSON.stringify(seen[0]?.messages)).toContain("first line");
    expect(seen[0]?.tools).toBeUndefined();
  });

  test("a provider failure gives the extractive summary, not an error", async () => {
    const summary = await make(fixedAdapter(new Error("503")))(transcript, "INSTRUCTIONS");
    expect(summary).toContain("first line");
    expect(summary).toContain("last line");
  });

  test("a reply with no text gives the extractive summary", async () => {
    const summary = await make(fixedAdapter(""))(transcript, "INSTRUCTIONS");
    expect(summary).toContain("first line");
  });
});

describe("the fold of a turn that has no session owner", () => {
  test("on a context overflow the model writes the summary, and the retry holds it", async () => {
    const requests: ProviderRequest[] = [];
    const adapter: ProviderAdapter = {
      family: "fake",
      async *stream(request): AsyncIterable<StreamEvent> {
        requests.push(request);
        if (request.system === compactionPrompt()) {
          yield { type: "text_delta", text: "SUMMARY: the user wants the port changed to 8443" };
          yield { type: "message_stop", stopReason: "end_turn", usage };
          return;
        }
        if (requests.length === 1) {
          throw new AgencyError(ErrorCode.CONTEXT_OVERFLOW, "context full", { source: "fake" });
        }
        yield { type: "text_delta", text: "done" };
        yield { type: "message_stop", stopReason: "end_turn", usage };
      },
    };
    const result = await runTurn(adapter, new Scheduler({ maxAttempts: 1 }), noopHttp, {
      identity: { type: "user" },
      capabilities: FULL_CAPABILITIES,
      systemPrompt: "sys",
      tools: [],
      model: "m",
      apiKey: "k",
      contextWindow: 1000,
      session: Array.from({ length: 8 }, (_, i) =>
        text(i % 2 === 0 ? "user" : "assistant", `message ${i} ${"word ".repeat(320)}`),
      ),
    });
    expect(result.stopReason).toBe("end_turn");
    const summaryRequest = requests.find((r) => r.system === compactionPrompt());
    expect(JSON.stringify(summaryRequest?.messages)).toContain("message 0");
    expect(JSON.stringify(requests.at(-1)?.messages)).toContain(
      "SUMMARY: the user wants the port changed to 8443",
    );
  });
});

test("the instructions of the user for a summary go to the summarizer after the built-in rules", async () => {
  const seen: ProviderRequest[] = [];
  const ask = { adapter: fixedAdapter("a summary", seen), http: noopHttp, model: "m", apiKey: "k" };
  await modelSummarizer({ ...ask, instructions: "Keep every file path. Write in German." })(
    "the transcript",
    "RULES",
  );
  expect(seen[0]?.system).toStartWith("RULES");
  expect(seen[0]?.system).toContain("Keep every file path. Write in German.");
  await modelSummarizer(ask)("the transcript", "RULES");
  expect(seen[1]?.system).toBe("RULES");
});

describe("a fold after a request that the provider cached", () => {
  const run = async (cachedInputTokens: number, session?: Message[]) => {
    const requests: ProviderRequest[] = [];
    const isWhole = (r: ProviderRequest) =>
      JSON.stringify(r.messages.at(-1)).includes("This message is from the harness");
    const adapter: ProviderAdapter = {
      family: "fake",
      async *stream(request): AsyncIterable<StreamEvent> {
        requests.push(request);
        if (isWhole(request) || request.system === compactionPrompt()) {
          yield { type: "text_delta", text: "SUMMARY: the user wants the port changed to 8443" };
          yield { type: "message_stop", stopReason: "end_turn", usage };
          return;
        }
        if (requests.length === 1) {
          yield { type: "tool_call_start", id: "c1", name: "echo" };
          yield { type: "tool_call_delta", id: "c1", inputJsonDelta: "{}" };
          yield { type: "tool_call_end", id: "c1" };
          yield {
            type: "message_stop",
            stopReason: "tool_use",
            usage: { inputTokens: 950, outputTokens: 1, cachedInputTokens },
          };
          return;
        }
        yield { type: "text_delta", text: "done" };
        yield { type: "message_stop", stopReason: "end_turn", usage };
      },
    };
    const result = await runTurn(adapter, new Scheduler({ maxAttempts: 1 }), noopHttp, {
      identity: { type: "user" },
      capabilities: FULL_CAPABILITIES,
      systemPrompt: "sys",
      tools: [
        {
          name: "echo",
          description: "echo",
          inputSchema: { type: "object", properties: {} },
          handler: async () => ({ content: "echoed" }),
        },
      ],
      model: "m",
      apiKey: "k",
      contextWindow: 1000,
      session:
        session ??
        Array.from({ length: 8 }, (_, i) =>
          text(i % 2 === 0 ? "user" : "assistant", `message ${i} ${"word ".repeat(320)}`),
        ),
    });
    expect(result.stopReason).toBe("end_turn");
    expect(JSON.stringify(requests.at(-1)?.messages)).toContain(
      "SUMMARY: the user wants the port changed to 8443",
    );
    return { requests, whole: requests.find(isWhole) };
  };

  test("asks the summary at the end of that request, so the provider reads the history from its cache", async () => {
    const { requests, whole } = await run(900);
    const first = requests[0] as ProviderRequest;
    expect(whole?.system).toBe(first.system);
    expect(JSON.stringify(whole?.tools)).toBe(JSON.stringify(first.tools));
    expect(JSON.stringify(whole?.messages.slice(0, first.messages.length))).toBe(
      JSON.stringify(first.messages),
    );
    // The tool result after that request goes too, with the prompt in the same user message.
    expect(JSON.stringify(whole?.messages.at(-1))).toContain("echoed");
    expect(requests.some((r) => r.system === compactionPrompt())).toBe(false);
  });

  test("with no cached tokens, the chunks of the transcript go to the summarizer as before", async () => {
    const { requests, whole } = await run(0);
    expect(whole).toBeUndefined();
    expect(requests.some((r) => r.system === compactionPrompt())).toBe(true);
  });

  test("comes before the removal of old tool results, which would lose what they said", async () => {
    // Removing the old result alone would bring this history under the target.
    const { requests, whole } = await run(900, [
      text("user", "read it"),
      { role: "assistant", content: [{ type: "tool_call", id: "c0", name: "echo", input: {} }] },
      {
        role: "user",
        content: [
          { type: "tool_result", toolCallId: "c0", content: `the secret is w919 ${"filler ".repeat(600)}` },
        ],
      },
      text("assistant", "read"),
      text("user", "go on"),
    ]);
    expect(whole).toBeDefined();
    expect(JSON.stringify(requests.at(-1)?.messages)).not.toContain("output removed to save context");
  });
});
