import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import type { Redactor } from "@agency/guard";
import type { EventBus } from "./events.ts";

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

export interface LogEntry {
  time: string;
  level: LogLevel;
  message: string;
  traceId?: string;
  [key: string]: unknown;
}

interface TraceContext {
  traceId: string;
}

const traceStorage = new AsyncLocalStorage<TraceContext>();

/**
 * Runs `fn` with a trace ID bound to it and everything it calls, so a turn's
 * provider requests and tool calls all correlate in the logs without threading
 * an id through every function signature by hand.
 */
export function withTrace<T>(fn: () => T, traceId: string = randomUUID()): T {
  return traceStorage.run({ traceId }, fn);
}

export function currentTraceId(): string | undefined {
  return traceStorage.getStore()?.traceId;
}

export interface LoggerOptions {
  level?: LogLevel;
  sink?: (line: string) => void;
  bus?: EventBus;
  /** When set, every message and field value is scrubbed through it before
   *  it reaches the sink or the bus (R11: redaction at the boundary, not at
   *  call sites). */
  redactor?: Redactor;
}

/** Recursively redacts string values so a secret nested in a field object
 *  can't slip past the chokepoint. */
function redactValue(value: unknown, redactor: Redactor): unknown {
  if (typeof value === "string") return redactor.redact(value);
  if (Array.isArray(value)) return value.map((v) => redactValue(v, redactor));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redactValue(v, redactor)]));
  }
  return value;
}

/** Structured JSON-lines logger. One line per entry, trace-correlated, redaction-ready. */
export class Logger {
  private readonly level: LogLevel;
  private readonly sink: (line: string) => void;
  private readonly bus?: EventBus;
  private readonly redactor?: Redactor;

  constructor(options: LoggerOptions = {}) {
    this.level = options.level ?? "info";
    this.sink = options.sink ?? ((line) => console.log(line));
    this.bus = options.bus;
    this.redactor = options.redactor;
  }

  private write(level: LogLevel, message: string, fields?: Record<string, unknown>): void {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[this.level]) return;

    const redactor = this.redactor;
    const safeMessage = redactor ? redactor.redact(message) : message;
    const safeFields =
      redactor && fields ? (redactValue(fields, redactor) as Record<string, unknown>) : fields;

    const entry: LogEntry = {
      time: new Date().toISOString(),
      level,
      message: safeMessage,
      traceId: currentTraceId(),
      ...safeFields,
    };

    this.sink(JSON.stringify(entry));
    this.bus?.emit("log.entry", { level, message: safeMessage, traceId: entry.traceId });
  }

  debug(message: string, fields?: Record<string, unknown>): void {
    this.write("debug", message, fields);
  }
  info(message: string, fields?: Record<string, unknown>): void {
    this.write("info", message, fields);
  }
  warn(message: string, fields?: Record<string, unknown>): void {
    this.write("warn", message, fields);
  }
  error(message: string, fields?: Record<string, unknown>): void {
    this.write("error", message, fields);
  }
}
