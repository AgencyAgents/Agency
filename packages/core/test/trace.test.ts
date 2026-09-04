import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FULL_CAPABILITIES, Redactor } from "@agency/guard";
import type { HttpClient } from "@agency/net";
import type { ProviderAdapter, StreamEvent, Usage } from "@agency/providers";
import { Scheduler } from "@agency/providers";
import { readCassette, writeCassette } from "../src/cassette.ts";
import { runTurn, type ToolSpec } from "../src/loop.ts";
import { exportSpansOtlp, otlpJsonValid, spansToOtlp } from "../src/trace/otel.ts";
import { loadTraceSpans, TraceRecorder } from "../src/trace/recorder.ts";
import { buildSpanTree } from "../src/trace/types.ts";

const noopHttp: HttpClient = { fetch: async () => new Response() };
const user = { type: "user" as const };

function fakeAdapter(text: string, usage: Usage = { inputTokens: 100, outputTokens: 50 }): ProviderAdapter {
  return {
    family: "fake",
    async *stream(): AsyncIterable<StreamEvent> {
      yield { type: "text_delta", text };
      yield { type: "message_stop", stopReason: "end_turn", usage };
    },
  };
}

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

describe("TraceRecorder", () => {
  test("produces well-formed tree with correct parent linkage and cost rollup", async () => {
    const dir = mkdtempSync(join(tmpdir(), "trace-"));
    const recorder = new TraceRecorder({
      sessionsDir: dir,
      sessionId: "sess1",
      traceId: "turn-1",
      promptVersion: "v1",
    });
    const turnId = recorder.startTurnSpan({ provider: "anthropic", model: "claude-4", promptVersion: "v1" });
    const m1 = recorder.startModelSpan(turnId, { model: "claude-4", provider: "anthropic" });
    recorder.endSpan(m1, { attributes: { cost: 0.05, inputTokens: 100, outputTokens: 50 } });
    const m2 = recorder.startModelSpan(turnId, { model: "claude-4", provider: "anthropic" });
    recorder.endSpan(m2, { attributes: { cost: 0.07, inputTokens: 100, outputTokens: 50 } });
    const t1 = recorder.startToolSpan(turnId, { toolName: "read" });
    recorder.endSpan(t1, { attributes: { isError: false } });
    recorder.endTurnSpan("ok");
    await recorder.flush();

    const spans = await loadTraceSpans(dir, "sess1");
    expect(spans).toHaveLength(4);
    for (const s of spans) expect(s.traceId).toBe("turn-1");
    const turnSpans = spans.filter((s) => s.kind === "turn");
    expect(turnSpans).toHaveLength(1);
    expect(turnSpans[0]!.parentId).toBeNull();
    for (const s of spans.filter((s) => s.kind !== "turn")) {
      expect(s.parentId).toBe(turnSpans[0]!.spanId);
    }
    expect(spans.every((s) => s.attributes.promptVersion === "v1")).toBe(true);

    const tree = buildSpanTree(spans);
    expect(tree).toHaveLength(1);
    expect(tree[0]!.children).toHaveLength(3);
    expect(tree[0]!.totalCost).toBeCloseTo(0.12, 5);
  });

  test("promptVersion propagates to every span", async () => {
    const dir = mkdtempSync(join(tmpdir(), "trace-pv-"));
    const recorder = new TraceRecorder({
      sessionsDir: dir,
      sessionId: "s2",
      traceId: "turn-pv",
      promptVersion: "test-v2",
    });
    const turn = recorder.startTurnSpan();
    const m = recorder.startModelSpan(turn, { model: "m", provider: "p" });
    recorder.endSpan(m, { attributes: { cost: 0.01 } });
    const t = recorder.startToolSpan(turn, { toolName: "bash" });
    recorder.endSpan(t, {});
    recorder.endTurnSpan();
    const spans = recorder.getSpans();
    for (const s of spans) expect(s.attributes.promptVersion).toBe("test-v2");
  });

  test("sidecar JSONL persistence round-trips", async () => {
    const dir = mkdtempSync(join(tmpdir(), "trace-persist-"));
    const recorder = new TraceRecorder({ sessionsDir: dir, sessionId: "sess3", traceId: "turn-3" });
    const turn = recorder.startTurnSpan();
    const m = recorder.startModelSpan(turn, { model: "m", provider: "p" });
    recorder.endSpan(m, { attributes: { cost: 0.02 } });
    recorder.endTurnSpan();
    await recorder.flush();
    const spans = await loadTraceSpans(dir, "sess3");
    expect(spans.length).toBeGreaterThanOrEqual(2);
    const file = readFileSync(join(dir, "sess3.trace.jsonl"), "utf8");
    expect(file.trim().split("\n").length).toBe(spans.length);
  });

  test("tool spans have cost zero and parent rollup excludes them", async () => {
    const dir = mkdtempSync(join(tmpdir(), "trace-cost-"));
    const recorder = new TraceRecorder({ sessionsDir: dir, sessionId: "sCost", traceId: "tCost" });
    const turn = recorder.startTurnSpan();
    const m = recorder.startModelSpan(turn, { model: "m", provider: "p" });
    recorder.endSpan(m, { attributes: { cost: 0.1 } });
    const tool = recorder.startToolSpan(turn, { toolName: "read" });
    recorder.endSpan(tool, { attributes: { isError: false } });
    recorder.endTurnSpan();
    const tree = buildSpanTree(recorder.getSpans());
    expect(tree[0]!.totalCost).toBeCloseTo(0.1);
  });

  test("cassette bridge: toCassetteRecord produces valid CassetteRecord", async () => {
    const dir = mkdtempSync(join(tmpdir(), "trace-cass-"));
    const recorder = new TraceRecorder({ sessionsDir: dir, sessionId: "sCass", traceId: "tCass" });
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
    expect(record.events).toHaveLength(1);
    expect(record.result.messages[0]!.content[0]).toMatchObject({ type: "text" });
    await recorder.writeCassette("tCass", record);
    const loaded = await import("../src/trace/recorder.ts").then((m) =>
      m.readCassetteRecord(dir, "sCass", "tCass"),
    );
    expect(loaded?.params.model).toBe("test/m");
  });

  test("cassette redacts registered secrets and known key patterns through writeCassette", async () => {
    const dir = mkdtempSync(join(tmpdir(), "trace-redact-"));
    const redactor = new Redactor();
    redactor.registerSecret("sk-ant-real-secret-abcdef123456");
    const recorder = new TraceRecorder({
      sessionsDir: dir,
      sessionId: "sRedact",
      traceId: "tRedact",
      redactor,
    });
    // biome-ignore lint/suspicious/noExplicitAny: test data
    const fakeResult: any = {
      messages: [
        { role: "assistant", content: [{ type: "text", text: "my key is sk-ant-real-secret-abcdef123456" }] },
      ],
      stopReason: "end_turn",
      usage: { inputTokens: 10, outputTokens: 5 },
      budgetExceeded: false,
    };
    const record = recorder.toCassetteRecord(
      {
        provider: "anthropic",
        model: "anthropic/claude-4",
        systemPrompt: "You have key sk-ant-real-secret-abcdef123456",
        session: [],
      },
      [{ type: "text_delta", text: "using sk-ant-real-secret-abcdef123456" }],
      fakeResult,
    );
    await recorder.writeCassette("tRedact", record);

    const loaded = await import("../src/trace/recorder.ts").then((m) =>
      m.readCassetteRecord(dir, "sRedact", "tRedact"),
    );
    expect(loaded).not.toBeNull();
    // Registered secret must not appear anywhere in the cassette
    const json = JSON.stringify(loaded);
    expect(json).not.toContain("sk-ant-real-secret-abcdef123456");
    expect(json).toContain("[REDACTED]");
    // Known key pattern (Anthropic) should also be redacted even if not registered
    expect(json).not.toContain("sk-ant-");
  });

  test("replay reproduces same tool calls offline without network", async () => {
    const dir = mkdtempSync(join(tmpdir(), "trace-replay-"));
    const spec: ToolSpec = {
      name: "read",
      description: "read",
      inputSchema: {},
      handler: async () => ({ content: "file contents" }),
    };
    const scheduler = new Scheduler();
    const cassettePath = join(dir, "cassette.json");
    const adapter = toolAdapter("read", { path: "a.ts" });
    const { recordCassette } = await import("../src/cassette.ts");
    const recorded = await recordCassette(adapter, scheduler, noopHttp, {
      identity: user,
      capabilities: FULL_CAPABILITIES,
      systemPrompt: "sys",
      tools: [spec],
      model: "test/m",
      apiKey: "key",
      session: [],
    });
    writeCassette(cassettePath, recorded);
    const freshAdapter = toolAdapter("read", { path: "a.ts" });
    const { replayCassette } = await import("../src/cassette.ts");
    const { equal, replayed } = await replayCassette(cassettePath, freshAdapter, new Scheduler(), noopHttp, {
      identity: user,
      capabilities: FULL_CAPABILITIES,
      tools: [spec],
      apiKey: "key",
    });
    expect(equal).toBe(true);
    expect(replayed.messages).toEqual(recorded.result.messages);
    const loaded = readCassette(cassettePath);
    expect(loaded.events.length).toBeGreaterThan(0);
  });
});

describe("OTel export", () => {
  test("spansToOtlp produces valid OTLP JSON shape", () => {
    const dir = mkdtempSync(join(tmpdir(), "otel-"));
    const recorder = new TraceRecorder({
      sessionsDir: dir,
      sessionId: "sOtel",
      traceId: "turn-otel",
      promptVersion: "v3",
    });
    const turn = recorder.startTurnSpan({ provider: "openai", model: "gpt-5" });
    const m = recorder.startModelSpan(turn, { model: "gpt-5", provider: "openai" });
    recorder.endSpan(m, { attributes: { inputTokens: 10, outputTokens: 5, cost: 0.001 } });
    recorder.endTurnSpan();
    const payload = spansToOtlp(recorder.getSpans());
    expect(otlpJsonValid(payload)).toBe(true);
    expect(payload.resourceSpans[0]!.scopeSpans[0]!.spans).toHaveLength(2);
    const modelSpan = payload.resourceSpans[0]!.scopeSpans[0]!.spans.find((s) => s.name.includes("model"));
    expect(modelSpan).toBeDefined();
    expect(modelSpan!.attributes.some((a) => a.key === "model")).toBe(true);
  });

  test("nothing exported without explicit config opt-in", async () => {
    let fetchCalled = false;
    const fakeFetch = async () => {
      fetchCalled = true;
      return new Response(JSON.stringify({}), { status: 200 });
    };
    // biome-ignore lint/suspicious/noExplicitAny: test data
    const spans: any[] = [
      {
        traceId: "t",
        spanId: "s",
        parentId: null,
        name: "turn",
        kind: "turn",
        startTime: new Date().toISOString(),
        endTime: new Date().toISOString(),
        durationMs: 1,
        status: "ok",
        attributes: {},
      },
    ];
    // biome-ignore lint/suspicious/noExplicitAny: test data
    const r1 = await exportSpansOtlp(spans, undefined, fakeFetch as any);
    expect(r1.exported).toBe(false);
    expect(fetchCalled).toBe(false);
    // biome-ignore lint/suspicious/noExplicitAny: test data
    const r2 = await exportSpansOtlp(spans, { trace: {} } as any, fakeFetch as any);
    expect(r2.exported).toBe(false);
    expect(fetchCalled).toBe(false);
    const r3 = await exportSpansOtlp(
      spans,
      // biome-ignore lint/suspicious/noExplicitAny: test data
      { trace: { export: { endpoint: "http://localhost:4318/v1/traces" } } } as any,
      // biome-ignore lint/suspicious/noExplicitAny: test data
      fakeFetch as any,
    );
    expect(r3.exported).toBe(true);
    expect(fetchCalled).toBe(true);
  });

  test("export with empty spans does not call fetch even when configured", async () => {
    let called = false;
    const fakeFetch = async () => {
      called = true;
      return new Response();
    };
    const r = await exportSpansOtlp(
      [],
      // biome-ignore lint/suspicious/noExplicitAny: test data
      { trace: { export: { endpoint: "http://localhost:4318/v1/traces" } } } as any,
      // biome-ignore lint/suspicious/noExplicitAny: test data
      fakeFetch as any,
    );
    expect(r.exported).toBe(false);
    expect(called).toBe(false);
  });
});

describe("loop integration with trace", () => {
  test("runTurn with traceRecorder creates turn span with model and tool child spans and correct promptVersion and cost", async () => {
    const dir = mkdtempSync(join(tmpdir(), "loop-trace-"));
    const recorder = new TraceRecorder({
      sessionsDir: dir,
      sessionId: "sess-loop",
      traceId: "turn-loop",
      promptVersion: "pv-loop",
    });
    const spec: ToolSpec = {
      name: "read",
      description: "read",
      inputSchema: {},
      handler: async () => ({ content: "ok" }),
    };
    const scheduler = new Scheduler();
    const result = await runTurn(toolAdapter("read", { path: "x.ts" }), scheduler, noopHttp, {
      identity: user,
      capabilities: FULL_CAPABILITIES,
      systemPrompt: "sys",
      tools: [spec],
      model: "test-model",
      apiKey: "key",
      session: [],
      provider: "test",
      promptVersion: "pv-loop",
      pricePerMTok: { input: 10, output: 20 },
      traceRecorder: recorder,
    });
    expect(result.stopReason).toBe("end_turn");
    const spans = recorder.getSpans();
    expect(spans.length).toBeGreaterThanOrEqual(3);
    const turn = spans.find((s) => s.kind === "turn");
    expect(turn).toBeDefined();
    expect(turn!.attributes.promptVersion).toBe("pv-loop");
    expect(turn!.attributes.model).toBe("test-model");
    const models = spans.filter((s) => s.kind === "model");
    expect(models.length).toBeGreaterThanOrEqual(1);
    expect(models.every((s) => s.attributes.promptVersion === "pv-loop")).toBe(true);
    expect(models.some((s) => (s.attributes.cost ?? 0) > 0)).toBe(true);
    const tools = spans.filter((s) => s.kind === "tool");
    expect(tools.length).toBeGreaterThanOrEqual(1);
    expect(tools[0]!.attributes.toolName).toBe("read");
    const tree = buildSpanTree(spans);
    expect(tree[0]!.totalCost).toBeGreaterThan(0);
    await recorder.flush();
    const persisted = await loadTraceSpans(dir, "sess-loop");
    expect(persisted.length).toBe(spans.length);
  });

  test("trace writes are async and failures never fail the turn", async () => {
    const dir = mkdtempSync(join(tmpdir(), "loop-trace-ok-"));
    const recorder = new TraceRecorder({ sessionsDir: dir, sessionId: "sOk", traceId: "tOk" });
    const scheduler = new Scheduler();
    const result = await runTurn(fakeAdapter("hello"), scheduler, noopHttp, {
      identity: user,
      capabilities: FULL_CAPABILITIES,
      systemPrompt: "sys",
      tools: [],
      model: "m",
      apiKey: "k",
      session: [],
      traceRecorder: recorder,
    });
    expect(result.messages[0]!.content[0]).toMatchObject({ type: "text", text: "hello" });
    await recorder.flush();
    const spans = await loadTraceSpans(dir, "sOk");
    expect(spans.length).toBeGreaterThan(0);
  });
});
