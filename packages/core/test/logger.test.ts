import { describe, expect, test } from "bun:test";
import { Redactor } from "@agency/guard";
import { EventBus } from "../src/events.ts";
import { currentTraceId, Logger, withTrace } from "../src/logger.ts";

describe("Logger", () => {
  test("writes structured JSON lines with level and message", () => {
    const lines: string[] = [];
    const logger = new Logger({ sink: (line) => lines.push(line) });

    logger.info("provider connected", { provider: "anthropic" });

    expect(lines).toHaveLength(1);
    const entry = JSON.parse(lines[0]!);
    expect(entry.level).toBe("info");
    expect(entry.message).toBe("provider connected");
    expect(entry.provider).toBe("anthropic");
    expect(typeof entry.time).toBe("string");
  });

  test("filters entries below the configured level", () => {
    const lines: string[] = [];
    const logger = new Logger({ level: "warn", sink: (line) => lines.push(line) });

    logger.debug("too quiet to log");
    logger.info("also too quiet");
    logger.warn("this one lands");

    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!).message).toBe("this one lands");
  });

  test("correlates entries within withTrace under the same trace ID", () => {
    const lines: string[] = [];
    const logger = new Logger({ sink: (line) => lines.push(line) });

    withTrace(() => {
      logger.info("request sent");
      logger.info("response received");
    }, "trace-123");

    logger.info("outside any trace");

    const [first, second, third] = lines.map((l) => JSON.parse(l));
    expect(first.traceId).toBe("trace-123");
    expect(second.traceId).toBe("trace-123");
    expect(third.traceId).toBeUndefined();
  });

  test("nested async work inherits the enclosing trace ID", async () => {
    await withTrace(async () => {
      await Promise.resolve();
      expect(currentTraceId()).toBe("trace-async");
    }, "trace-async");
  });

  test("emits a log.entry event on the bus for every write", () => {
    const bus = new EventBus();
    const seen: string[] = [];
    bus.on("log.entry", (payload: unknown) => {
      seen.push((payload as { message: string }).message);
    });

    const logger = new Logger({ sink: () => {}, bus });
    logger.error("boom");

    expect(seen).toEqual(["boom"]);
  });

  test("survives a self-referential field object without blowing the stack", () => {
    const lines: string[] = [];
    const logger = new Logger({ sink: (line) => lines.push(line), redactor: new Redactor() });

    const fields: Record<string, unknown> = { name: "cycle" };
    fields.self = fields;
    logger.info("cyclic fields", fields);

    expect(lines).toHaveLength(1);
    const entry = JSON.parse(lines[0]!);
    expect(entry.self).toBe("[Circular]");
  });

  test("caps recursion depth on deeply nested fields", () => {
    const lines: string[] = [];
    const logger = new Logger({ sink: (line) => lines.push(line), redactor: new Redactor() });

    let deep: Record<string, unknown> = { value: "bottom" };
    for (let i = 0; i < 100; i += 1) deep = { nested: deep };
    logger.info("deep fields", { root: deep });

    expect(lines).toHaveLength(1);
    const entry = JSON.parse(lines[0]!);
    let node: Record<string, unknown> = entry.root;
    while (typeof node.nested === "object" && node.nested !== null) node = node.nested as never;
    expect(node.nested).toBe("[Truncated]");
  });

  test("redaction still reaches strings nested inside field objects", () => {
    const lines: string[] = [];
    const redactor = new Redactor();
    redactor.registerSecret("sk-hunter2-secret");
    const logger = new Logger({ sink: (line) => lines.push(line), redactor });

    logger.info("nested secret", { auth: { key: "token sk-hunter2-secret leaked" } });

    const entry = JSON.parse(lines[0]!);
    expect(entry.auth.key).toBe("token [REDACTED] leaked");
  });
});
