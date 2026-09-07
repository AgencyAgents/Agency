import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFileTrustStore } from "@agency/guard";
import type { HttpClient } from "@agency/net";
import type { ModelInfo } from "@agency/providers";
import { createFileFallbackBackend } from "@agency/providers";
import { debugCommand } from "../src/debug.ts";
import { runOnboarding } from "../src/onboarding.ts";

function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

const noopHttp: HttpClient = { fetch: async () => new Response() };

function catalogModel(id: string, family: string): ModelInfo {
  return {
    id,
    family,
    name: id,
    providerName: family,
    contextWindow: 100_000,
    maxOutputTokens: 8_000,
    pricing: { inputPerMTok: 1, outputPerMTok: 2 },
    capabilities: { tools: true, vision: false, thinking: false },
  };
}

function scriptedPrompter(answers: string[]) {
  const queue = [...answers];
  const asked: string[] = [];
  return {
    asked,
    line: (prompt: string) => {
      asked.push(prompt);
      return Promise.resolve(queue.shift() ?? "");
    },
    secret: (prompt: string) => {
      asked.push(prompt);
      return Promise.resolve(queue.shift() ?? "");
    },
    confirm: (prompt: string) => {
      asked.push(prompt);
      return Promise.resolve((queue.shift() ?? "n").toLowerCase().startsWith("y"));
    },
  };
}

describe("runOnboarding", () => {
  test("no credentials -> connect -> model -> trust, persisting each decision", async () => {
    const root = tempDir("agency-onboard-ws-");
    const configDir = tempDir("agency-onboard-config-");
    const keysDir = tempDir("agency-onboard-keys-");
    const trustPath = join(tempDir("agency-onboard-trust-"), "trust.json");
    const cacheDir = tempDir("agency-onboard-cache-");
    const prompter = scriptedPrompter(["openai", "sk-test-openai-key-123", "", "y"]);

    const result = await runOnboarding({
      workspaceRoot: root,
      prompter,
      env: {},
      configDir,
      keychain: createFileFallbackBackend(keysDir),
      trustStore: createFileTrustStore(trustPath),
      http: noopHttp,
      catalog: [catalogModel("gpt-5.2", "openai")],
      cacheDir,
    });

    expect(result.completed).toBe(true);
    expect(result.connectedProvider).toBe("openai");
    expect(result.model).toBe("openai/gpt-5.2");
    expect(result.trusted).toBe(true);

    const config = JSON.parse(readFileSync(join(configDir, "config.jsonc"), "utf8"));
    expect(config.model).toBe("openai/gpt-5.2");
    expect(createFileTrustStore(trustPath).isTrusted(root)).toBe(true);

    const key = await createFileFallbackBackend(keysDir).get("openai");
    expect(key).toBe("sk-test-openai-key-123");
  });

  test("already-connected providers skip the connect step", async () => {
    const root = tempDir("agency-onboard-ws-");
    const configDir = tempDir("agency-onboard-config-");
    const prompter = scriptedPrompter(["", "y"]);

    const result = await runOnboarding({
      workspaceRoot: root,
      prompter,
      env: { AGENCY_OPENAI_API_KEY: "sk-env-key" },
      configDir,
      keychain: createFileFallbackBackend(tempDir("agency-onboard-keys-")),
      trustStore: createFileTrustStore(join(tempDir("agency-onboard-trust-"), "trust.json")),
      http: noopHttp,
      catalog: [catalogModel("gpt-5.2", "openai")],
      cacheDir: tempDir("agency-onboard-cache-"),
    });

    expect(result.completed).toBe(true);
    expect(result.connectedProvider).toBe("openai");
    expect(prompter.asked.some((p) => p.toLowerCase().includes("provider to connect"))).toBe(false);
  });

  test("an aborted connect leaves nothing stored and reports incomplete", async () => {
    const root = tempDir("agency-onboard-ws-");
    const configDir = tempDir("agency-onboard-config-");
    const prompter = scriptedPrompter([""]);

    const result = await runOnboarding({
      workspaceRoot: root,
      prompter,
      env: {},
      configDir,
      keychain: createFileFallbackBackend(tempDir("agency-onboard-keys-")),
      trustStore: createFileTrustStore(join(tempDir("agency-onboard-trust-"), "trust.json")),
      http: noopHttp,
      catalog: [catalogModel("gpt-5.2", "openai")],
      cacheDir: tempDir("agency-onboard-cache-"),
    });

    expect(result.completed).toBe(false);
    expect(existsSync(join(configDir, "config.jsonc"))).toBe(false);
  });

  test("declining trust completes onboarding but leaves the directory untrusted", async () => {
    const root = tempDir("agency-onboard-ws-");
    const trustPath = join(tempDir("agency-onboard-trust-"), "trust.json");
    const prompter = scriptedPrompter(["", "n"]);

    const result = await runOnboarding({
      workspaceRoot: root,
      prompter,
      env: { AGENCY_OPENAI_API_KEY: "sk-env-key" },
      configDir: tempDir("agency-onboard-config-"),
      keychain: createFileFallbackBackend(tempDir("agency-onboard-keys-")),
      trustStore: createFileTrustStore(trustPath),
      http: noopHttp,
      catalog: [catalogModel("gpt-5.2", "openai")],
      cacheDir: tempDir("agency-onboard-cache-"),
    });

    expect(result.completed).toBe(true);
    expect(result.trusted).toBe(false);
    expect(createFileTrustStore(trustPath).isTrusted(root)).toBe(false);
  });
});

describe("debugCommand", () => {
  test("writes a redacted bundle file and returns its path", () => {
    const outDir = tempDir("agency-debug-out-");
    const { path, report } = debugCommand({
      workspaceRoot: outDir,
      outDir,
      version: "0.1.0",
      now: () => new Date(0),
    });

    expect(existsSync(path)).toBe(true);
    expect(path).toContain("agency-debug-");
    expect(report).toContain("# Agency debug bundle");
    const written = readFileSync(path, "utf8");
    expect(written).toContain("# Agency debug bundle");
    rmSync(outDir, { recursive: true, force: true });
  });
});
