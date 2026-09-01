import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, updateGlobalConfig } from "../src/config/loader.ts";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "agency-config-write-test-"));
}

describe("updateGlobalConfig", () => {
  test("creates a config when none exists and the result parses", () => {
    const dir = tempDir();
    const config = updateGlobalConfig({ model: "openai/gpt-5.2" }, { globalDir: dir, env: {} });
    expect(config.model).toBe("openai/gpt-5.2");
    expect(config.telemetryEnabled).toBe(false);
    expect(loadConfig({ globalDir: dir, env: {} }).model).toBe("openai/gpt-5.2");
    rmSync(dir, { recursive: true, force: true });
  });

  test("merges into an existing config without dropping unknown fields", () => {
    const dir = tempDir();
    writeFileSync(
      join(dir, "config.jsonc"),
      JSON.stringify({ schemaVersion: 2, logLevel: "debug", telemetryEnabled: true }),
    );

    const config = updateGlobalConfig({ model: "anthropic/claude-sonnet-5" }, { globalDir: dir, env: {} });
    expect(config.logLevel).toBe("debug");
    expect(config.telemetryEnabled).toBe(true);
    expect(config.model).toBe("anthropic/claude-sonnet-5");
    rmSync(dir, { recursive: true, force: true });
  });
});
