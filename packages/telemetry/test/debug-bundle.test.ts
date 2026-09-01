import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Redactor } from "@agency/guard";
import { buildDebugBundle, formatDebugBundle } from "../src/debug-bundle.ts";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "agency-debug-bundle-test-"));
}

describe("buildDebugBundle", () => {
  test("redacts secrets from the log tail and never includes config values", () => {
    const root = tempDir();
    // win32 logDir() resolves to %LOCALAPPDATA%\Agency\logs; pointing
    // LOCALAPPDATA at the temp root keeps the bundle's reads inside it.
    const logsDir = join(root, "Agency", "logs");
    mkdirSync(logsDir, { recursive: true });
    writeFileSync(
      join(logsDir, "agency.log"),
      [
        JSON.stringify({
          time: "t",
          level: "info",
          message: "turn started",
          apiKey: "sk-ant-leak-me-1234567890",
        }),
        JSON.stringify({ time: "t", level: "info", message: "connected with sk-ant-leak-me-1234567890" }),
      ].join("\n"),
    );

    const redactor = new Redactor();
    redactor.registerSecret("sk-ant-leak-me-1234567890");

    const bundle = buildDebugBundle({
      workspaceRoot: root,
      redactor,
      env: { LOCALAPPDATA: root, AGENCY_ANTHROPIC_API_KEY: "sk-ant-leak-me-1234567890", TERM: "xterm" },
      platform: "win32",
      version: "0.1.0",
    });

    expect(bundle.logTail).not.toContain("sk-ant-leak-me-1234567890");
    expect(bundle.logTail).toContain("[REDACTED]");
    expect(bundle.environment.AGENCY_ANTHROPIC_API_KEY).toBeUndefined();
    expect(bundle.environment.TERM).toBe("xterm");
    expect(bundle.config.present).toBe(false); // no config file present
    expect(bundle.workspaceId).toHaveLength(16);
    rmSync(root, { recursive: true, force: true });
  });

  test("summarizes config as ids only, even when the file carries an apiKey", () => {
    const root = tempDir();
    // win32 configPath() resolves to %APPDATA%\Agency\config.jsonc.
    const configDir = join(root, "Agency");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      join(configDir, "config.jsonc"),
      JSON.stringify({
        schemaVersion: 2,
        provider: {
          "my-gateway": { apiKey: "super-secret-config-key", baseUrl: "http://localhost:8080/v1" },
        },
      }),
    );

    const bundle = buildDebugBundle({
      workspaceRoot: root,
      redactor: new Redactor(),
      env: { APPDATA: root },
      platform: "win32",
    });

    const serialized = JSON.stringify(bundle);
    expect(serialized).not.toContain("super-secret-config-key");
    expect(bundle.config.providerIds).toEqual(["my-gateway"]);
    rmSync(root, { recursive: true, force: true });
  });

  test("formatDebugBundle renders a pasteable report with no secret material", () => {
    const root = tempDir();
    const bundle = buildDebugBundle({
      workspaceRoot: root,
      redactor: new Redactor(),
      env: {},
      platform: "darwin",
      listSessions: () => [{ id: "abc", bytes: 120, entries: 3 }],
    });

    const report = formatDebugBundle(bundle);
    expect(report).toContain("# Agency debug bundle");
    expect(report).toContain("- abc: 120 bytes, 3 entries");
    expect(report).toContain("(empty)");
    rmSync(root, { recursive: true, force: true });
  });
});
