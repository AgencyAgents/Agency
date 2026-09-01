import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Redactor } from "@agency/guard";
import { createFileTelemetrySink, Telemetry } from "../src/telemetry.ts";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "agency-telemetry-test-"));
}

function lines(path: string): unknown[] {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l));
}

describe("Telemetry", () => {
  test("records nothing when disabled (the default)", () => {
    const dir = tempDir();
    const path = join(dir, "events.jsonl");
    const telemetry = new Telemetry({
      enabled: false,
      crashReports: { enabled: false },
      redactor: new Redactor(),
      sink: createFileTelemetrySink(path),
    });

    telemetry.record("turn_complete", { inputTokens: 5 });
    telemetry.recordCrash("scope", new Error("boom"));

    expect(existsSync(path)).toBe(false);
  });

  test("records redacted scalar events when enabled", () => {
    const dir = tempDir();
    const path = join(dir, "events.jsonl");
    const redactor = new Redactor();
    redactor.registerSecret("sk-ant-secret-value-123456");
    const telemetry = new Telemetry({
      enabled: true,
      redactor,
      sink: createFileTelemetrySink(path),
    });

    telemetry.record("turn_complete", {
      provider: "anthropic",
      inputTokens: 10,
      leaked: "sk-ant-secret-value-123456",
      nested: { nope: true } as unknown as string,
    });

    const [event] = lines(path) as Array<{ name: string; fields: Record<string, unknown> }>;
    expect(event!.name).toBe("turn_complete");
    expect(event!.fields.provider).toBe("anthropic");
    expect(event!.fields.inputTokens).toBe(10);
    expect(event!.fields.leaked).toBe("[REDACTED]");
    expect(event!.fields.nested).toBeUndefined();
    rmSync(dir, { recursive: true, force: true });
  });

  test("crash reports are gated behind their own opt-in and redacted", () => {
    const dir = tempDir();
    const path = join(dir, "events.jsonl");
    const redactor = new Redactor();
    redactor.registerSecret("sk-ant-secret-value-123456");

    const off = new Telemetry({
      enabled: true,
      crashReports: { enabled: false },
      redactor,
      sink: createFileTelemetrySink(path),
    });
    off.recordCrash("run_turn", new Error("key sk-ant-secret-value-123456 rejected"));
    expect(existsSync(path)).toBe(false);

    const on = new Telemetry({
      enabled: true,
      crashReports: { enabled: true },
      redactor,
      sink: createFileTelemetrySink(path),
    });
    on.recordCrash("run_turn", new Error("key sk-ant-secret-value-123456 rejected"));

    const [event] = lines(path) as Array<{ name: string; fields: Record<string, string> }>;
    expect(event!.name).toBe("crash");
    expect(event!.fields.message).not.toContain("sk-ant-secret-value-123456");
    expect(event!.fields.message).toContain("[REDACTED]");
    rmSync(dir, { recursive: true, force: true });
  });
});
