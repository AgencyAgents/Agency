import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConfigFingerprint, DEFAULT_IDLE_LINGER_MS, HEARTBEAT_INTERVAL_MS } from "../src/daemon.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "agency-daemon-lifecycle42-"));
  dirs.push(dir);
  return dir;
}

describe("daemon lifecycle constants (item 42)", () => {
  test("heartbeat broadcasts every 10s", () => {
    expect(HEARTBEAT_INTERVAL_MS).toBe(10_000);
  });

  test("idle linger defaults to 10m", () => {
    expect(DEFAULT_IDLE_LINGER_MS).toBe(10 * 60 * 1000);
  });
});

describe("config fingerprint mtime warn (item 42)", () => {
  test("check() is false when nothing changed", () => {
    const dir = tempDir();
    const cfg = join(dir, "config.jsonc");
    writeFileSync(cfg, "{}");
    const fp = createConfigFingerprint([cfg]);
    expect(fp.check()).toBe(false);
  });

  test("check() is true after the config mtime changes", async () => {
    const dir = tempDir();
    const cfg = join(dir, "config.jsonc");
    writeFileSync(cfg, "{}");
    const fp = createConfigFingerprint([cfg]);
    await new Promise((r) => setTimeout(r, 5));
    writeFileSync(cfg, '{ "model": "x" }');
    expect(fp.check()).toBe(true);
  });

  test("check() is true when a tracked file is deleted", () => {
    const dir = tempDir();
    const cfg = join(dir, "config.jsonc");
    writeFileSync(cfg, "{}");
    const fp = createConfigFingerprint([cfg]);
    rmSync(cfg);
    expect(fp.check()).toBe(true);
  });

  test("check() is true when a previously-missing file appears", () => {
    const dir = tempDir();
    const cfg = join(dir, "config.jsonc");
    const fp = createConfigFingerprint([cfg]);
    expect(fp.check()).toBe(false);
    writeFileSync(cfg, "{}");
    expect(fp.check()).toBe(true);
  });

  test("missing files on both sides stay clean", () => {
    const fp = createConfigFingerprint([join(tempDir(), "nope.jsonc")]);
    expect(fp.check()).toBe(false);
  });
});
