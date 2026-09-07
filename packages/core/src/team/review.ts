export type InspectGranularity = "timeline" | "step" | "reasoning";

export interface InspectableSpan {
  step: number;
  tool: string;
  target: string;
  ok: boolean;
  durationMs: number;
  tokens: number;
  costUsd: number;
  input?: string;
  output?: string;
  thinking?: string;
}

export interface TraceSpanLike {
  name: string;
  kind: string;
  status: string;
  durationMs: number | null;
  attributes: Record<string, unknown>;
}

// Timeline rows derive from recorded tool spans, full payloads
// from the same spans plus cassette and history text. No new store.
export function spansToInspectable(spans: readonly TraceSpanLike[]): InspectableSpan[] {
  const tools = spans.filter((s) => s.kind === "tool");
  return tools.map((span, index) => {
    const attrs = span.attributes;
    const tool = typeof attrs.toolName === "string" ? attrs.toolName : span.name.replace(/^tool:/, "");
    const target =
      typeof attrs.target === "string" ? attrs.target : typeof attrs.path === "string" ? attrs.path : "";
    const tokens =
      typeof attrs.tokens === "number"
        ? attrs.tokens
        : (typeof attrs.inputTokens === "number" ? attrs.inputTokens : 0) +
          (typeof attrs.outputTokens === "number" ? attrs.outputTokens : 0);
    const costUsd =
      typeof attrs.costUsd === "number" ? attrs.costUsd : typeof attrs.cost === "number" ? attrs.cost : 0;
    return {
      step: index + 1,
      tool,
      target,
      ok: span.status === "ok",
      durationMs: span.durationMs ?? 0,
      tokens,
      costUsd,
      ...(typeof attrs.input === "string" ? { input: attrs.input } : {}),
      ...(typeof attrs.output === "string" ? { output: attrs.output } : {}),
      ...(typeof attrs.thinking === "string" ? { thinking: attrs.thinking } : {}),
    };
  });
}

export interface TimelineFilter {
  since?: number;
  limit?: number;
  where?: "errors" | "writes" | { glob: string };
}

const WRITE_TOOLS = new Set(["write", "edit", "bash", "apply_patch"]);

function globMatch(glob: string, target: string): boolean {
  const pattern = glob
    .replace(/\\/g, "/")
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*");
  return new RegExp(`^${pattern}$`).test(target.replace(/\\/g, "/"));
}

export function inspectTimeline(spans: readonly InspectableSpan[], filter: TimelineFilter = {}): string[] {
  let rows = spans.filter((s) => (filter.since === undefined ? true : s.step > filter.since));
  const where = filter.where;
  if (where === "errors") rows = rows.filter((s) => !s.ok);
  else if (where === "writes") rows = rows.filter((s) => WRITE_TOOLS.has(s.tool));
  else if (where !== undefined && typeof where !== "string") {
    rows = rows.filter((s) => globMatch(where.glob, s.target));
  }
  rows = rows.slice(0, filter.limit ?? 100);
  return rows.map(
    (s) =>
      `#${s.step} ${s.tool} ${s.target.slice(0, 60)} ${s.ok ? "ok" : "err"} ${s.durationMs}ms ${s.tokens}t $${s.costUsd.toFixed(4)}`,
  );
}

export interface StepDetail {
  step: number;
  tool: string;
  input: string;
  output: string;
  thinking: string;
}

// One step in full: exact input, full output under the shared
// truncation, and the thinking block that preceded it.
export function inspectStep(
  spans: readonly InspectableSpan[],
  step: number,
  historyThinking: readonly string[] = [],
): StepDetail | undefined {
  const span = spans.find((s) => s.step === step);
  if (!span) return undefined;
  const prior = span.thinking ?? historyThinking[step - 1] ?? "";
  return {
    step: span.step,
    tool: span.tool,
    input: span.input ?? "",
    output: (span.output ?? "").slice(0, 50 * 1024),
    thinking: prior,
  };
}

export function inspectReasoning(
  spans: readonly InspectableSpan[],
  fromStep: number,
  toStep: number,
  capChars = 8000,
): string {
  const parts: string[] = [];
  for (const span of spans) {
    if (span.step < fromStep || span.step > toStep) continue;
    if (span.thinking && span.thinking.length > 0) parts.push(`#${span.step} ${span.thinking}`);
    if (parts.join("\n").length >= capChars) break;
  }
  return parts.join("\n").slice(0, capChars);
}

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

// The lead may inspect every agent on its team; a peer may
// inspect only items it collaborates on. Inspection is billed.
export function canInspect(args: {
  requester: string;
  isLead: boolean;
  targetHandle: string;
  sharedItems: readonly string[];
  targetItems: readonly string[];
}): boolean {
  if (args.requester === args.targetHandle) return true;
  if (args.isLead) return true;
  return args.targetItems.some((item) => args.sharedItems.includes(item));
}

// Redaction passes through the shared secret pattern before
// anything pulled is shown in the inspecting window.
export function redactInspectText(text: string, secrets: readonly string[] = []): string {
  let out = text;
  for (const secret of secrets) {
    if (secret.length > 0) out = out.split(secret).join("[redacted]");
  }
  return out
    .replace(/(sk-[a-zA-Z0-9-_]{8,})/g, "[redacted]")
    .replace(/(ghp_[a-zA-Z0-9]{8,})/g, "[redacted]")
    .replace(/([A-Za-z0-9_.-]*token[A-Za-z0-9_.-]*\s*[:=]\s*\S+)/gi, "[redacted]");
}

export const INSPECT_CHARGE_USD = 0.0001;
