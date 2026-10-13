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
