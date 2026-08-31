import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config/loader.ts";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "agency-config-test-"));
}

const cleanup: string[] = [];
afterEach(() => {
  for (const dir of cleanup.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("loadConfig", () => {
  test("falls back to defaults with no layers present", () => {
    const dir = tempDir();
    cleanup.push(dir);
    const config = loadConfig({ globalDir: dir, env: {} });
    expect(config.logLevel).toBe("info");
    expect(config.locale).toBe("en");
  });

  test("project config overrides global config", () => {
    const globalDir = tempDir();
    const projectRoot = tempDir();
    cleanup.push(globalDir, projectRoot);

    writeFileSync(join(globalDir, "config.jsonc"), `{ "schemaVersion": 1, "logLevel": "warn" }`);
    mkdirSync(join(projectRoot, ".agency"));
    writeFileSync(
      join(projectRoot, ".agency", "config.jsonc"),
      `{ "schemaVersion": 1, "logLevel": "debug" }`,
    );

    const config = loadConfig({ globalDir, projectRoot, env: {} });
    expect(config.logLevel).toBe("debug");
  });

  test("env var overrides project config", () => {
    const globalDir = tempDir();
    const projectRoot = tempDir();
    cleanup.push(globalDir, projectRoot);

    mkdirSync(join(projectRoot, ".agency"));
    writeFileSync(
      join(projectRoot, ".agency", "config.jsonc"),
      `{ "schemaVersion": 1, "logLevel": "debug" }`,
    );

    const config = loadConfig({
      globalDir,
      projectRoot,
      env: { AGENCY_LOG_LEVEL: "error" },
    });
    expect(config.logLevel).toBe("error");
  });

  test("CLI flags override env vars", () => {
    const globalDir = tempDir();
    cleanup.push(globalDir);

    const config = loadConfig({
      globalDir,
      env: { AGENCY_LOG_LEVEL: "error" },
      flags: { logLevel: "debug" },
    });
    expect(config.logLevel).toBe("debug");
  });

  test("managed config overrides even CLI flags", () => {
    const globalDir = tempDir();
    cleanup.push(globalDir);
    const managedPath = join(globalDir, "managed.jsonc");
    writeFileSync(managedPath, `{ "schemaVersion": 1, "logLevel": "error" }`);

    const config = loadConfig({
      globalDir,
      managedPath,
      env: {},
      flags: { logLevel: "debug" },
    });
    expect(config.logLevel).toBe("error");
  });

  test("migrates a v0 global config forward transparently", () => {
    const globalDir = tempDir();
    cleanup.push(globalDir);
    // v0 predates `locale` entirely, and has no schemaVersion field at all.
    writeFileSync(join(globalDir, "config.jsonc"), `{ "logLevel": "warn" }`);

    const config = loadConfig({ globalDir, env: {} });
    expect(config.schemaVersion).toBe(1);
    expect(config.locale).toBe("en");
    expect(config.logLevel).toBe("warn");
  });

  test("tolerates JSONC comments", () => {
    const globalDir = tempDir();
    cleanup.push(globalDir);
    writeFileSync(
      join(globalDir, "config.jsonc"),
      `{
        // house style
        "schemaVersion": 1,
        "logLevel": "debug", // trailing comma below is fine too
      }`,
    );

    const config = loadConfig({ globalDir, env: {} });
    expect(config.logLevel).toBe("debug");
  });
});
