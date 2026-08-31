import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createKeychain } from "../../src/auth/keychain.ts";
import type { SpawnFn } from "../../src/auth/types.ts";

const cleanup: string[] = [];
afterEach(() => {
  for (const dir of cleanup.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "agency-keychain-select-"));
  cleanup.push(dir);
  return dir;
}

describe("createKeychain", () => {
  test("uses the native backend for the platform when it's available", async () => {
    const available: SpawnFn = async () => ({ stdout: "", stderr: "", exitCode: 0 });
    const keychain = await createKeychain("darwin", tempDir(), available);
    expect(keychain.name).toBe("macos-keychain");
  });

  test("falls back to the encrypted file store when the native backend is unavailable", async () => {
    const unavailable: SpawnFn = async () => ({ stdout: "", stderr: "not found", exitCode: 127 });
    const keychain = await createKeychain("linux", tempDir(), unavailable);
    expect(keychain.name).toBe("file-fallback");
  });

  test("the fallback keychain still works end-to-end", async () => {
    const unavailable: SpawnFn = async () => ({ stdout: "", stderr: "", exitCode: 1 });
    const keychain = await createKeychain("linux", tempDir(), unavailable);

    await keychain.set("anthropic", "sk-ant-secret");
    expect(await keychain.get("anthropic")).toBe("sk-ant-secret");
  });

  test("selects the windows backend on win32", async () => {
    const available: SpawnFn = async () => ({ stdout: "", stderr: "", exitCode: 0 });
    const keychain = await createKeychain("win32", tempDir(), available);
    expect(keychain.name).toBe("windows-dpapi");
  });
});
