import type { TraceSpan } from "./types.ts";

export interface OtlpExportConfig {
  endpoint: string;
  headers?: Record<string, string>;
}

export interface OtlpPayload {
  resourceSpans: Array<{
    resource: { attributes: Array<{ key: string; value: { stringValue: string } }> };
    scopeSpans: Array<{
      scope: { name: string; version: string };
      spans: Array<{
        traceId: string;
        spanId: string;
        parentSpanId: string;
        name: string;
        kind: number;
        startTimeUnixNano: string;
        endTimeUnixNano: string;
        status: { code: number; message?: string };
        attributes: Array<{
          key: string;
          value:
            | { stringValue: string }
            | { doubleValue: number }
            | { intValue: string }
            | { boolValue: boolean };
        }>;
      }>;
    }>;
  }>;
}

function toNanoString(iso: string | null): string {
  if (!iso) return "0";
  const ms = new Date(iso).getTime();
  if (!Number.isFinite(ms)) return "0";
  return String(BigInt(ms) * 1_000_000n);
}

function hexToTraceId(traceId: string): string {
  // OTLP expects 32 hex chars for traceId, 16 for spanId. Our traceId is UUID hex (32 chars) or turnId.
  // Pad or truncate to 32 hex chars using char codes.
  const hex = traceId.replace(/-/g, "").padEnd(32, "0").slice(0, 32);
  // Ensure hex chars only: replace non-hex with 0
  return hex.replace(/[^0-9a-fA-F]/g, "0").toLowerCase();
}

function hexToSpanId(spanId: string): string {
  const hex = spanId.replace(/-/g, "").padEnd(16, "0").slice(0, 16);
  return hex.replace(/[^0-9a-fA-F]/g, "0").toLowerCase();
}

function spanKindToOtel(kind: TraceSpan["kind"]): number {
  switch (kind) {
    case "turn":
      return 1; // INTERNAL
    case "model":
      return 3; // CLIENT
    case "tool":
      return 1; // INTERNAL
    default:
      return 0;
  }
}

function statusToOtel(status: TraceSpan["status"]): { code: number; message?: string } {
  switch (status) {
    case "ok":
      return { code: 1 };
    case "error":
      return { code: 2, message: "error" };
    case "cancelled":
      return { code: 2, message: "cancelled" };
    default:
      return { code: 0 };
  }
}

export function spansToOtlp(spans: TraceSpan[], resourceAttributes?: Record<string, string>): OtlpPayload {
  const otelSpans = spans.map((s) => ({
    traceId: hexToTraceId(s.traceId),
    spanId: hexToSpanId(s.spanId),
    parentSpanId: s.parentId ? hexToSpanId(s.parentId) : "",
    name: s.name,
    kind: spanKindToOtel(s.kind),
    startTimeUnixNano: toNanoString(s.startTime),
    endTimeUnixNano: toNanoString(s.endTime),
    status: statusToOtel(s.status),
    attributes: [
      ...(s.attributes.provider
        ? [{ key: "provider", value: { stringValue: String(s.attributes.provider) } }]
        : []),
      ...(s.attributes.model ? [{ key: "model", value: { stringValue: String(s.attributes.model) } }] : []),
      ...(s.attributes.promptVersion
        ? [{ key: "prompt.version", value: { stringValue: String(s.attributes.promptVersion) } }]
        : []),
      ...(s.attributes.toolName
        ? [{ key: "tool.name", value: { stringValue: String(s.attributes.toolName) } }]
        : []),
      ...(s.attributes.inputTokens !== undefined
        ? [{ key: "tokens.input", value: { intValue: String(s.attributes.inputTokens) } }]
        : []),
      ...(s.attributes.outputTokens !== undefined
        ? [{ key: "tokens.output", value: { intValue: String(s.attributes.outputTokens) } }]
        : []),
      ...(s.attributes.cachedInputTokens !== undefined
        ? [{ key: "tokens.cached_input", value: { intValue: String(s.attributes.cachedInputTokens) } }]
        : []),
      ...(s.attributes.cost !== undefined
        ? [{ key: "cost", value: { doubleValue: s.attributes.cost } }]
        : []),
      ...(s.attributes.isError !== undefined
        ? [{ key: "tool.is_error", value: { boolValue: Boolean(s.attributes.isError) } }]
        : []),
      { key: "span.kind", value: { stringValue: s.kind } },
    ],
  }));

  const resourceAttrs = Object.entries(resourceAttributes ?? { "service.name": "agency" }).map(([k, v]) => ({
    key: k,
    value: { stringValue: String(v) },
  }));

  return {
    resourceSpans: [
      {
        resource: { attributes: resourceAttrs },
        scopeSpans: [
          {
            scope: { name: "agency", version: "0.1.0" },
            spans: otelSpans,
          },
        ],
      },
    ],
  };
}

export function otlpJsonValid(payload: unknown): boolean {
  if (!payload || typeof payload !== "object") return false;
  const p = payload as Record<string, unknown>;
  if (!Array.isArray(p.resourceSpans)) return false;
  for (const rs of p.resourceSpans as unknown[]) {
    if (!rs || typeof rs !== "object") return false;
    const r = rs as Record<string, unknown>;
    if (!r.resource || !Array.isArray((r as { scopeSpans?: unknown }).scopeSpans)) return false;
    for (const ss of r.scopeSpans as unknown[]) {
      if (!ss || typeof ss !== "object") return false;
      const s = ss as Record<string, unknown>;
      if (!Array.isArray((s as { spans?: unknown }).spans)) return false;
    }
  }
  return true;
}

export async function exportSpansOtlp(
  spans: TraceSpan[],
  config: { trace?: { export?: OtlpExportConfig } } | undefined,
  fetchImpl: typeof fetch = fetch,
): Promise<{ exported: boolean; endpoint?: string }> {
  const endpoint = config?.trace?.export?.endpoint;
  if (!endpoint) return { exported: false };
  if (spans.length === 0) return { exported: false };
  const payload = spansToOtlp(spans);
  const headers = config?.trace?.export?.headers ?? {};
  try {
    await fetchImpl(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...headers,
      },
      body: JSON.stringify(payload),
    });
  } catch {
    // Export failures never throw — observability must not break the turn.
  }
  return { exported: true, endpoint };
}
