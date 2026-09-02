import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Redactor } from "@agency/guard";
import { createRotatingFileSink } from "../src/log-sink.ts";
import { Logger } from "../src/logger.ts";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "agency-log-sink-test-"));
}

describe("createRotatingFileSink", () => {
  test("persists JSONL lines to the active file", async () => {
    const dir = tempDir();
    const sink = createRotatingFileSink({ dir, fileName: "agency.log" });
    sink.write(JSON.stringify({ message: "one" }));
    sink.write(JSON.stringify({ message: "two" }));
    await sink.flush();

    const content = readFileSync(join(dir, "agency.log"), "utf8");
    expect(content.split("\n").filter((l) => l.length > 0)).toHaveLength(2);
    rmSync(dir, { recursive: true, force: true });
  });

  test("flush() resolves only after every queued line is on disk, in order", async () => {
    const dir = tempDir();
    const sink = createRotatingFileSink({ dir, fileName: "agency.log" });
    for (let i = 0; i < 50; i++) sink.write(JSON.stringify({ i }));
    await sink.flush();

    const lines = readFileSync(join(dir, "agency.log"), "utf8")
      .split("\n")
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l) as { i: number });
    expect(lines.map((l) => l.i)).toEqual([...Array(50).keys()]);
    rmSync(dir, { recursive: true, force: true });
  });

  test("rotates when the size cap is exceeded and keeps maxFiles backups", async () => {
    const dir = tempDir();
    const sink = createRotatingFileSink({ dir, fileName: "agency.log", maxBytes: 100, maxFiles: 2 });

    for (let i = 0; i < 10; i++) {
      sink.write(`line-${i}-${"x".repeat(30)}`);
    }
    await sink.flush();

    expect(existsSync(join(dir, "agency.log"))).toBe(true);
    expect(existsSync(join(dir, "agency.log.1"))).toBe(true);
    expect(existsSync(join(dir, "agency.log.2"))).toBe(true);
    expect(existsSync(join(dir, "agency.log.3"))).toBe(false);

    const active = readFileSync(join(dir, "agency.log"), "utf8");
    expect(active).toContain("line-9");
    rmSync(dir, { recursive: true, force: true });
  });

  test("a Logger wired to the sink redacts secrets before they hit disk", async () => {
    const dir = tempDir();
    const redactor = new Redactor();
    redactor.registerSecret("sk-ant-on-disk-secret-123456");
    const sink = createRotatingFileSink({ dir });
    const logger = new Logger({
      sink: (line) => sink.write(line),
      redactor,
    });

    logger.info("connected", { apiKey: "sk-ant-on-disk-secret-123456" });
    await sink.flush();

    const content = readFileSync(join(dir, "agency.log"), "utf8");
    expect(content).not.toContain("sk-ant-on-disk-secret-123456");
    expect(content).toContain("[REDACTED]");
    rmSync(dir, { recursive: true, force: true });
  });
});
