import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FULL_CAPABILITIES } from "@agency/guard";
import type { HttpClient } from "@agency/net";
import type { ProviderAdapter, StreamEvent, Usage } from "@agency/providers";
import { Scheduler } from "@agency/providers";
import { runTurn, type ToolSpec } from "../src/loop.ts";
import { loadTraceSpans, readCassetteRecord, TraceRecorder } from "../src/trace/recorder.ts";

const noopHttp: HttpClient = { fetch: async () => new Response() };
const user = { type: "user" as const };

function toolAdapter(toolName: string, input: Record<string, unknown>): ProviderAdapter {
  let call = 0;
  return {
    family: "fake",
    async *stream(): AsyncIterable<StreamEvent> {
      call++;
      if (call === 1) {
        yield { type: "tool_call_start", id: "call_1", name: toolName };
        yield { type: "tool_call_delta", id: "call_1", inputJsonDelta: JSON.stringify(input) };
        yield { type: "tool_call_end", id: "call_1" };
        yield { type: "message_stop", stopReason: "tool_use", usage: { inputTokens: 100, outputTokens: 50 } };
      } else {
        yield { type: "text_delta", text: "done" };
        yield { type: "message_stop", stopReason: "end_turn", usage: { inputTokens: 10, outputTokens: 5 } };
      }
    },
  };
}

describe("item 39: observability spans", () => {
  test("turn span carries provider/model/promptVersion/inputTokens/outputTokens/cost", async () => {
    const dir = mkdtempSync(join(tmpdir(), "trace39-turn-"));
    const recorder = new TraceRecorder({
      sessionsDir: dir,
      sessionId: "s39",
      traceId: "turn-39",
      promptVersion: "pv39",
    });
    const spec: ToolSpec = {
      name: "read",
      description: "read",
      inputSchema: {},
      handler: async () => ({ content: "ok" }),
    };
    await runTurn(toolAdapter("read", { path: "x.ts" }), new Scheduler(), noopHttp, {
      identity: user,
      capabilities: FULL_CAPABILITIES,
      systemPrompt: "sys",
      tools: [spec],
      model: "test-model",
      apiKey: "key",
      session: [],
      provider: "test",
      promptVersion: "pv39",
      pricePerMTok: { input: 10, output: 20 },
      traceRecorder: recorder,
    });
    const spans = recorder.getSpans();
    const turn = spans.find((s) => s.kind === "turn");
    expect(turn).toBeDefined();
    expect(turn!.attributes.provider).toBe("test");
    expect(turn!.attributes.model).toBe("test-model");
    expect(turn!.attributes.promptVersion).toBe("pv39");
    // Two model rounds: 100+10 in, 50+5 out
    expect(turn!.attributes.inputTokens).toBe(110);
    expect(turn!.attributes.outputTokens).toBe(55);
    expect(turn!.attributes.cost).toBeGreaterThan(0);
    expect(turn!.endTime).not.toBeNull();
    expect(turn!.durationMs).not.toBeNull();

    const models = spans.filter((s) => s.kind === "model");
    expect(models.length).toBeGreaterThanOrEqual(1);
    for (const m of models) {
      expect(m.attributes.provider).toBe("test");
      expect(m.attributes.model).toBe("test-model");
      expect(m.attributes.promptVersion).toBe("pv39");
      expect(typeof m.attributes.inputTokens).toBe("number");
      expect(typeof m.attributes.outputTokens).toBe("number");
      expect(typeof m.attributes.cost).toBe("number");
      expect(m.parentId).toBe(turn!.spanId);
    }

    const tools = spans.filter((s) => s.kind === "tool");
    expect(tools.length).toBeGreaterThanOrEqual(1);
    expect(tools[0]!.attributes.toolName).toBe("read");
    expect(tools[0]!.attributes.isError).toBe(false);
    expect(tools[0]!.parentId).toBe(turn!.spanId);
  });

  test("tool error span marks isError + error status", () => {
    const dir = mkdtempSync(join(tmpdir(), "trace39-err-"));
    const recorder = new TraceRecorder({ sessionsDir: dir, sessionId: "s39e", traceId: "t39e" });
    const turn = recorder.startTurnSpan({ provider: "p", model: "m" });
    const tool = recorder.startToolSpan(turn, { toolName: "bash" });
    recorder.endSpan(tool, { status: "error", attributes: { isError: true } });
    recorder.endTurnSpan("ok", { inputTokens: 1, outputTokens: 2, cost: 0.001 });
    const spans = recorder.getSpans();
    const toolSpan = spans.find((s) => s.kind === "tool")!;
    expect(toolSpan.status).toBe("error");
    expect(toolSpan.attributes.isError).toBe(true);
    expect(toolSpan.attributes.toolName).toBe("bash");
    const turnSpan = spans.find((s) => s.kind === "turn")!;
    expect(turnSpan.attributes.inputTokens).toBe(1);
    expect(turnSpan.attributes.cost).toBeCloseTo(0.001, 6);
  });

  test("flush is non-blocking (flushAsync returns void) and swallows failures", async () => {
    // Point sessionsDir at a path that cannot be created (a file in the way).
    const dir = mkdtempSync(join(tmpdir(), "trace39-bad-"));
    const blocker = join(dir, "blocker");
    writeFileSync(blocker, "not a dir");
    const recorder = new TraceRecorder({ sessionsDir: blocker, sessionId: "s39b", traceId: "t39b" });
    const turn = recorder.startTurnSpan({ provider: "p", model: "m" });
    const m = recorder.startModelSpan(turn, { model: "m", provider: "p" });
    recorder.endSpan(m, { attributes: { cost: 0.01, inputTokens: 5, outputTokens: 5 } });
    recorder.endTurnSpan();
    // Non-blocking: returns void synchronously, never throws.
    const ret = recorder.flushAsync();
    expect(ret).toBeUndefined();
    // Swallow: explicit flush also resolves (never rejects) despite bad dir.
    await recorder.flush();
    // Usage type check: invalid usage still accepted by costOf.
    const usage: Usage = { inputTokens: 100, outputTokens: 50 };
    expect(recorder.costOf(usage, { input: 10, output: 20 })).toBeCloseTo(0.002, 6);
  });

  test("sidecar JSONL flush persists every span as one JSON object per line", async () => {
    const dir = mkdtempSync(join(tmpdir(), "trace39-jsonl-"));
    const recorder = new TraceRecorder({ sessionsDir: dir, sessionId: "s39j", traceId: "t39j" });
    const turn = recorder.startTurnSpan({ provider: "p", model: "m" });
    const m = recorder.startModelSpan(turn, { model: "m", provider: "p" });
    recorder.endSpan(m, { attributes: { inputTokens: 1, outputTokens: 1, cost: 0.001 } });
    recorder.endTurnSpan("ok", { inputTokens: 1, outputTokens: 1, cost: 0.001 });
    await recorder.flush();
    const spans = await loadTraceSpans(dir, "s39j");
    expect(spans).toHaveLength(2);
  });

  test("cassette bridge: toCassetteRecord + writeCassette + readCassetteRecord round-trip", async () => {
    const dir = mkdtempSync(join(tmpdir(), "trace39-cass-"));
    const recorder = new TraceRecorder({ sessionsDir: dir, sessionId: "s39c", traceId: "t39c" });
    // biome-ignore lint/suspicious/noExplicitAny: test data
    const fakeResult: any = {
      messages: [{ role: "assistant", content: [{ type: "text", text: "hi" }] }],
      stopReason: "end_turn",
      usage: { inputTokens: 10, outputTokens: 5 },
      budgetExceeded: false,
    };
    const record = recorder.toCassetteRecord(
      { provider: "test", model: "test/m", systemPrompt: "sys", session: [] },
      [{ type: "text_delta", text: "hi" }],
      fakeResult,
    );
    expect(record.params.provider).toBe("test");
    await recorder.writeCassette("turn-1", record);
    const loaded = await readCassetteRecord(dir, "s39c", "turn-1");
    expect(loaded?.params.model).toBe("test/m");
    expect(loaded?.events).toHaveLength(1);
    expect(loaded?.result.stopReason).toBe("end_turn");
    // Missing cassette returns null instead of throwing.
    expect(await readCassetteRecord(dir, "s39c", "nope")).toBeNull();
  });
});
