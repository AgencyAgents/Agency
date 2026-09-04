import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exportSpansOtlp, otlpJsonValid, spansToOtlp } from "../src/trace/otel.ts";
import { TraceRecorder } from "../src/trace/recorder.ts";
import type { TraceSpan } from "../src/trace/types.ts";

function makeSpan(overrides: Partial<TraceSpan> = {}): TraceSpan {
  return {
    traceId: "turn-abc",
    spanId: "s1",
    parentId: null,
    name: "turn",
    kind: "turn",
    startTime: "2026-01-02T03:04:05.006Z",
    endTime: "2026-01-02T03:04:06.006Z",
    durationMs: 1000,
    status: "ok",
    attributes: {},
    ...overrides,
  };
}

describe("item 40: OTLP export mapping + gating", () => {
  test("maps to resourceSpans/scopeSpans with hex-padded ids and nano timestamps", () => {
    const spans = [
      makeSpan({ traceId: "t", spanId: "s", parentId: null }),
      makeSpan({
        traceId: "t",
        spanId: "child-1",
        parentId: "s",
        name: "model gpt",
        kind: "model",
        status: "error",
        attributes: { provider: "openai", model: "gpt-5", inputTokens: 10, outputTokens: 5, cost: 0.001 },
      }),
    ];
    const payload = spansToOtlp(spans);
    expect(otlpJsonValid(payload)).toBe(true);
    expect(payload.resourceSpans).toHaveLength(1);
    const rs = payload.resourceSpans[0]!;
    expect(rs.resource.attributes).toEqual([{ key: "service.name", value: { stringValue: "agency" } }]);
    expect(rs.scopeSpans).toHaveLength(1);
    expect(rs.scopeSpans[0]!.scope).toEqual({ name: "agency", version: "0.1.0" });
    const out = rs.scopeSpans[0]!.spans;
    expect(out).toHaveLength(2);

    // Hex padding: traceId 32 chars, spanId/parent 16 chars, lowercase hex only.
    for (const s of out) {
      expect(s.traceId).toMatch(/^[0-9a-f]{32}$/);
      expect(s.spanId).toMatch(/^[0-9a-f]{16}$/);
    }
    expect(out[0]!.parentSpanId).toBe("");
    expect(out[1]!.parentSpanId).toMatch(/^[0-9a-f]{16}$/);

    // Nano timestamps: ms * 1e6 as decimal string.
    const startMs = new Date("2026-01-02T03:04:05.006Z").getTime();
    const endMs = new Date("2026-01-02T03:04:06.006Z").getTime();
    expect(out[0]!.startTimeUnixNano).toBe(String(BigInt(startMs) * 1_000_000n));
    expect(out[0]!.endTimeUnixNano).toBe(String(BigInt(endMs) * 1_000_000n));

    // Kind/status mapping + attributes passthrough.
    expect(out[1]!.kind).toBe(3); // model -> CLIENT
    expect(out[1]!.status).toEqual({ code: 2, message: "error" });
    expect(out[1]!.attributes.some((a) => a.key === "model")).toBe(true);

    // Invalid ISO / null endTime degrades to "0", never NaN/throw.
    const bad = spansToOtlp([makeSpan({ startTime: "not-a-date", endTime: null })]);
    expect(bad.resourceSpans[0]!.scopeSpans[0]!.spans[0]!.startTimeUnixNano).toBe("0");
    expect(bad.resourceSpans[0]!.scopeSpans[0]!.spans[0]!.endTimeUnixNano).toBe("0");
  });

  test("exportSpansOtlp gated on config.trace.export.endpoint; empty endpoint/spans never fetch", async () => {
    const spans = [makeSpan()];
    const calls: Array<{ url: unknown; init: unknown }> = [];
    const fakeFetch = (async (url: unknown, init: unknown) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({}), { status: 200 });
    }) as unknown as typeof fetch;

    // No config / no trace / empty-string endpoint -> gated off.
    expect((await exportSpansOtlp(spans, undefined, fakeFetch)).exported).toBe(false);
    expect((await exportSpansOtlp(spans, { trace: {} } as never, fakeFetch)).exported).toBe(false);
    expect((await exportSpansOtlp(spans, { trace: { export: { endpoint: "" } } }, fakeFetch)).exported).toBe(
      false,
    );
    expect(calls).toHaveLength(0);

    // Empty spans even with endpoint -> gated off.
    expect(
      (await exportSpansOtlp([], { trace: { export: { endpoint: "http://x/v1/traces" } } }, fakeFetch))
        .exported,
    ).toBe(false);
    expect(calls).toHaveLength(0);

    // Configured endpoint -> single POST with OTLP JSON body + headers merged.
    const r = await exportSpansOtlp(
      spans,
      { trace: { export: { endpoint: "http://x/v1/traces", headers: { Authorization: "Bearer k" } } } },
      fakeFetch,
    );
    expect(r).toEqual({ exported: true, endpoint: "http://x/v1/traces" });
    expect(calls).toHaveLength(1);
    const init = calls[0]!.init as { method: string; headers: Record<string, string>; body: string };
    expect(init.method).toBe("POST");
    expect(init.headers["Content-Type"]).toBe("application/json");
    expect(init.headers.Authorization).toBe("Bearer k");
    expect(otlpJsonValid(JSON.parse(init.body))).toBe(true);

    // Fetch failure never throws.
    const throwing = (async () => {
      throw new Error("down");
    }) as unknown as typeof fetch;
    const r2 = await exportSpansOtlp(
      spans,
      { trace: { export: { endpoint: "http://x/v1/traces" } } },
      throwing,
    );
    expect(r2.exported).toBe(true);
  });

  test("recorder.flush never auto-exports (local file write only, no fetch)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "otlp-40-noauto-"));
    const origFetch = globalThis.fetch;
    let fetchCalled = false;
    (globalThis as unknown as { fetch: unknown }).fetch = (async () => {
      fetchCalled = true;
      return new Response();
    }) as unknown as typeof fetch;
    try {
      const recorder = new TraceRecorder({ sessionsDir: dir, sessionId: "s40", traceId: "t40" });
      const turn = recorder.startTurnSpan({ provider: "p", model: "m" });
      recorder.endSpan(turn);
      await recorder.flush();
      expect(fetchCalled).toBe(false);
    } finally {
      globalThis.fetch = origFetch;
    }
  });
});
