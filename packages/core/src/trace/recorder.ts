import { existsSync, readFileSync } from "node:fs";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Redactor } from "@agency/guard";
import type { CassetteRecord } from "../cassette.ts";
import type { LoopEvent, PricePerMTok } from "../loop.ts";
import type { SpanKind, SpanStatus, SpanTreeNode, TraceSpan } from "./types.ts";
import { buildSpanTree, filterSpansByTraceId, newSpanId } from "./types.ts";

export type { SpanKind, SpanStatus, SpanTreeNode, TraceSpan };

function tracePath(sessionsDir: string, sessionId: string): string {
  return join(sessionsDir, `${sessionId}.trace.jsonl`);
}

function cassettePath(sessionsDir: string, sessionId: string, turnId: string): string {
  return join(sessionsDir, `${sessionId}.${turnId}.cassette.json`);
}

export interface RecorderOptions {
  sessionsDir: string;
  sessionId: string;
  traceId: string;
  promptVersion?: string;
  provider?: string;
  model?: string;
  /** When set, cassette records are scrubbed through it before writing to disk
   *  (R11: redaction at the boundary, not at call sites). */
  redactor?: Redactor;
}

export class TraceRecorder {
  private readonly spans = new Map<string, TraceSpan>();
  private readonly order: string[] = [];
  readonly traceId: string;
  private readonly sessionsDir: string;
  private readonly sessionId: string;
  private readonly promptVersion?: string;
  private readonly redactor?: Redactor;
  private turnSpanId: string | null = null;

  constructor(options: RecorderOptions) {
    this.sessionsDir = options.sessionsDir;
    this.sessionId = options.sessionId;
    this.traceId = options.traceId;
    this.promptVersion = options.promptVersion;
    this.redactor = options.redactor;
  }

  startSpan(opts: {
    name: string;
    kind: SpanKind;
    parentId: string | null;
    attributes?: TraceSpan["attributes"];
    startTime?: string;
  }): string {
    const spanId = newSpanId();
    const now = opts.startTime ?? new Date().toISOString();
    const span: TraceSpan = {
      traceId: this.traceId,
      spanId,
      parentId: opts.parentId,
      name: opts.name,
      kind: opts.kind,
      startTime: now,
      endTime: null,
      durationMs: null,
      status: "ok",
      attributes: {
        ...(this.promptVersion ? { promptVersion: this.promptVersion } : {}),
        ...(opts.attributes ?? {}),
      },
    };
    this.spans.set(spanId, span);
    this.order.push(spanId);
    return spanId;
  }

  endSpan(
    spanId: string,
    opts?: { status?: SpanStatus; attributes?: Partial<TraceSpan["attributes"]>; endTime?: string },
  ): void {
    const span = this.spans.get(spanId);
    if (!span) return;
    const end = opts?.endTime ?? new Date().toISOString();
    span.endTime = end;
    span.durationMs = Math.max(0, new Date(end).getTime() - new Date(span.startTime).getTime());
    if (opts?.status) span.status = opts.status;
    if (opts?.attributes) {
      span.attributes = { ...span.attributes, ...opts.attributes };
    }
  }

  startTurnSpan(opts?: { name?: string; provider?: string; model?: string; promptVersion?: string }): string {
    const id = this.startSpan({
      name: opts?.name ?? `turn:${this.traceId}`,
      kind: "turn",
      parentId: null,
      attributes: {
        ...(opts?.provider ? { provider: opts.provider } : {}),
        ...(opts?.model ? { model: opts.model } : {}),
        ...((opts?.promptVersion ?? this.promptVersion)
          ? { promptVersion: opts?.promptVersion ?? this.promptVersion }
          : {}),
      },
    });
    this.turnSpanId = id;
    return id;
  }

  endTurnSpan(status: SpanStatus = "ok", attributes?: Partial<TraceSpan["attributes"]>): void {
    if (this.turnSpanId) this.endSpan(this.turnSpanId, { status, attributes });
  }

  startModelSpan(
    parentId: string | null,
    opts: { model: string; provider: string; promptVersion?: string },
  ): string {
    return this.startSpan({
      name: `model:${opts.model}`,
      kind: "model",
      parentId: parentId ?? this.turnSpanId,
      attributes: {
        provider: opts.provider,
        model: opts.model,
        ...((opts.promptVersion ?? this.promptVersion)
          ? { promptVersion: opts.promptVersion ?? this.promptVersion }
          : {}),
      },
    });
  }

  startToolSpan(parentId: string | null, opts: { toolName: string; promptVersion?: string }): string {
    return this.startSpan({
      name: `tool:${opts.toolName}`,
      kind: "tool",
      parentId: parentId ?? this.turnSpanId,
      attributes: {
        toolName: opts.toolName,
        ...((opts.promptVersion ?? this.promptVersion)
          ? { promptVersion: opts.promptVersion ?? this.promptVersion }
          : {}),
      },
    });
  }

  getSpans(): TraceSpan[] {
    return this.order.map((id) => this.spans.get(id)).filter((s): s is TraceSpan => s !== undefined);
  }

  getTree(traceId?: string): SpanTreeNode[] {
    const spans = traceId ? filterSpansByTraceId(this.getSpans(), traceId) : this.getSpans();
    return buildSpanTree(spans);
  }

  getTurnSpanId(): string | null {
    return this.turnSpanId;
  }

  costOf(usage: { inputTokens: number; outputTokens: number }, price?: PricePerMTok): number {
    if (!price) return 0;
    return (usage.inputTokens / 1_000_000) * price.input + (usage.outputTokens / 1_000_000) * price.output;
  }

  toCassetteRecord(
    params: CassetteRecord["params"],
    events: LoopEvent[],
    result: CassetteRecord["result"],
  ): CassetteRecord {
    return { params, events, result };
  }

  private flushPromise: Promise<void> | undefined;
  private flushed = false;

  async flush(): Promise<void> {
    if (this.flushed) return;
    if (this.flushPromise) return this.flushPromise;
    const spans = this.getSpans();
    if (spans.length === 0) {
      this.flushed = true;
      return;
    }
    const path = tracePath(this.sessionsDir, this.sessionId);
    const lines = spans.map((s) => `${JSON.stringify(s)}\n`).join("");
    this.flushPromise = (async () => {
      try {
        await mkdir(this.sessionsDir, { recursive: true });
        await appendFile(path, lines);
      } catch {
        // Trace write failures must never fail the turn — swallow.
      } finally {
        this.flushed = true;
        this.flushPromise = undefined;
      }
    })();
    return this.flushPromise;
  }

  flushAsync(): void {
    void this.flush();
  }

  async writeCassette(turnId: string, record: CassetteRecord): Promise<void> {
    const path = cassettePath(this.sessionsDir, this.sessionId, turnId);
    try {
      await mkdir(this.sessionsDir, { recursive: true });
      const { writeFile } = await import("node:fs/promises");
      let json = JSON.stringify(record, null, 2);
      if (this.redactor) json = this.redactor.redact(json);
      await writeFile(path, json);
    } catch {
      // Cassette write failures are also non-fatal.
    }
  }
}

export function getTracePath(sessionsDir: string, sessionId: string): string {
  return tracePath(sessionsDir, sessionId);
}

export function getCassettePath(sessionsDir: string, sessionId: string, turnId: string): string {
  return cassettePath(sessionsDir, sessionId, turnId);
}

export async function loadTraceSpans(sessionsDir: string, sessionId: string): Promise<TraceSpan[]> {
  const path = tracePath(sessionsDir, sessionId);
  try {
    const text = await readFile(path, "utf8");
    const spans: TraceSpan[] = [];
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        const s = JSON.parse(line) as TraceSpan;
        if (s && typeof s.spanId === "string" && typeof s.traceId === "string") spans.push(s);
      } catch {
        // Skip corrupt lines.
      }
    }
    return spans;
  } catch {
    return [];
  }
}

export function loadTraceSpansSync(sessionsDir: string, sessionId: string): TraceSpan[] {
  const path = tracePath(sessionsDir, sessionId);
  if (!existsSync(path)) return [];
  try {
    const text = readFileSync(path, "utf8");
    const spans: TraceSpan[] = [];
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        const s = JSON.parse(line) as TraceSpan;
        if (s && typeof s.spanId === "string" && typeof s.traceId === "string") spans.push(s);
      } catch {
        // Skip corrupt.
      }
    }
    return spans;
  } catch {
    return [];
  }
}

export async function loadTraceTree(
  sessionsDir: string,
  sessionId: string,
  turnId?: string,
): Promise<SpanTreeNode[]> {
  const spans = await loadTraceSpans(sessionsDir, sessionId);
  const filtered = turnId ? filterSpansByTraceId(spans, turnId) : spans;
  return buildSpanTree(filtered);
}

export function loadTraceTreeSync(sessionsDir: string, sessionId: string, turnId?: string): SpanTreeNode[] {
  const spans = loadTraceSpansSync(sessionsDir, sessionId);
  const filtered = turnId ? filterSpansByTraceId(spans, turnId) : spans;
  return buildSpanTree(filtered);
}

export async function readCassetteRecord(
  sessionsDir: string,
  sessionId: string,
  turnId: string,
): Promise<CassetteRecord | null> {
  const path = cassettePath(sessionsDir, sessionId, turnId);
  try {
    const text = await readFile(path, "utf8");
    return JSON.parse(text) as CassetteRecord;
  } catch {
    return null;
  }
}
