import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Redactor } from "@agency/guard";

/**
 * Opt-in telemetry (P8): nothing is recorded until the user says yes, and
 * everything that is recorded passes through the R11 redactor first. The
 * payload contract is counts and codes only — no prompt or code content, ever.
 */

export interface TelemetryEvent {
  name: string;
  time: string;
  fields: Record<string, string | number | boolean | null>;
}

export interface TelemetrySink {
  write(event: TelemetryEvent): void;
}

/** Local JSONL sink; the only sink v1 ships. A remote endpoint would be a
 *  separate opt-in surface with its own privacy review. */
export function createFileTelemetrySink(path: string): TelemetrySink {
  return {
    write(event) {
      mkdirSync(dirname(path), { recursive: true });
      appendFileSync(path, `${JSON.stringify(event)}\n`);
    },
  };
}

export interface TelemetryOptions {
  /** Master switch, from config.telemetryEnabled. False records nothing. */
  enabled: boolean;
  redactor: Redactor;
  sink?: TelemetrySink;
  /** Crash reporting has its own switch (config.crashReportsEnabled). */
  crashReports?: { enabled: boolean };
}

export class Telemetry {
  private readonly sink: TelemetrySink | undefined;

  constructor(private readonly options: TelemetryOptions) {
    this.sink = options.enabled ? options.sink : undefined;
  }

  get enabled(): boolean {
    return this.sink !== undefined;
  }

  /** Records a named event with scalar fields. Every string value is redacted;
   *  non-scalar values are dropped rather than risk carrying content. */
  record(name: string, fields: Record<string, string | number | boolean | null> = {}): void {
    if (!this.sink) return;
    const redacted: Record<string, string | number | boolean | null> = {};
    for (const [key, value] of Object.entries(fields)) {
      if (value === null || typeof value === "number" || typeof value === "boolean") {
        redacted[key] = value;
      } else if (typeof value === "string") {
        redacted[key] = this.options.redactor.redact(value);
      }
      // undefined / objects: dropped, not coerced — a mistake here must not
      // smuggle structured content into the payload.
    }
    this.sink.write({ name, time: new Date().toISOString(), fields: redacted });
  }

  /** Records a crash report when crash reporting is opted in. The error
   *  message is redacted (it may quote a rejected request), the stack is
   *  kept — stacks are Agency's own frames, not user content. */
  recordCrash(scope: string, error: unknown): void {
    if (!this.options.crashReports?.enabled || !this.sink) return;
    const message = error instanceof Error ? error.message : String(error);
    const stack = error instanceof Error ? (error.stack ?? "") : "";
    this.sink.write({
      name: "crash",
      time: new Date().toISOString(),
      fields: {
        scope: this.options.redactor.redact(scope),
        message: this.options.redactor.redact(message),
        stack: this.options.redactor.redact(stack),
      },
    });
  }
}
