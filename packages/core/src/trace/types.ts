import { randomUUID } from "node:crypto";

export type SpanStatus = "ok" | "error" | "cancelled";
export type SpanKind = "turn" | "model" | "tool";

export interface TraceSpan {
  traceId: string;
  spanId: string;
  parentId: string | null;
  name: string;
  kind: SpanKind;
  startTime: string;
  endTime: string | null;
  durationMs: number | null;
  status: SpanStatus;
  attributes: {
    provider?: string;
    model?: string;
    promptVersion?: string;
    inputTokens?: number;
    outputTokens?: number;
    cachedInputTokens?: number;
    cost?: number;
    toolName?: string;
    isError?: boolean;
    effort?: string;
    agent?: string;
  };
}

export interface SpanTreeNode {
  span: TraceSpan;
  children: SpanTreeNode[];
  totalCost: number;
}

export function newSpanId(): string {
  return randomUUID().replace(/-/g, "").slice(0, 16);
}

export function newTraceId(): string {
  return randomUUID().replace(/-/g, "");
}

export function buildSpanTree(spans: TraceSpan[]): SpanTreeNode[] {
  const byId = new Map<string, SpanTreeNode>();
  for (const s of spans) {
    byId.set(s.spanId, { span: s, children: [], totalCost: s.attributes.cost ?? 0 });
  }
  const roots: SpanTreeNode[] = [];
  for (const node of byId.values()) {
    if (node.span.parentId && byId.has(node.span.parentId)) {
      byId.get(node.span.parentId)?.children.push(node);
    } else {
      roots.push(node);
    }
  }
  for (const node of byId.values()) {
    node.children.sort((a, b) => a.span.startTime.localeCompare(b.span.startTime));
  }
  roots.sort((a, b) => a.span.startTime.localeCompare(b.span.startTime));
  for (const root of roots) {
    rollupCost(root);
  }
  return roots;
}

function rollupCost(node: SpanTreeNode): number {
  let sum = node.span.attributes.cost ?? 0;
  for (const child of node.children) {
    sum += rollupCost(child);
  }
  node.totalCost = sum;
  if (node.span.kind === "turn" && node.children.length > 0 && (node.span.attributes.cost ?? 0) === 0) {
    node.totalCost = node.children.reduce((acc, c) => acc + c.totalCost, 0);
  }
  return node.totalCost;
}

export function filterSpansByTraceId(spans: TraceSpan[], traceId: string): TraceSpan[] {
  return spans.filter((s) => s.traceId === traceId);
}
