import { describe, expect, test, afterEach } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWindowsKeychainBackend } from "../../src/auth/windows.ts";

const cleanup: string[] = [];
afterEach(() => {
  for (const dir of cleanup.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "agency-dpapi-test-"));
  cleanup.push(dir);
  return dir;
}

// Real DPAPI round-trip via powershell.exe — only meaningful on Windows, and
// exercises the actual subprocess path this backend uses in production.
describe.skipIf(process.platform !== "win32")("createWindowsKeychainBackend (real DPAPI)", () => {
  test("is available on a Windows machine with PowerShell", async () => {
    expect(await createWindowsKeychainBackend(tempDir()).isAvailable()).toBe(true);
  });

  test("round-trips a secret through actual DPAPI encryption", async () => {
    const backend = createWindowsKeychainBackend(tempDir());
    await backend.set("anthropic", "sk-ant-real-dpapi-secret");
    expect(await backend.get("anthropic")).toBe("sk-ant-real-dpapi-secret");
  });

  test("the on-disk blob never contains the plaintext secret", async () => {
    const dir = tempDir();
    await createWindowsKeychainBackend(dir).set("anthropic", "sk-ant-should-not-appear-in-file");
    const raw = readFileSync(join(dir, "anthropic.dpapi"), "utf8");
    expect(raw).not.toContain("sk-ant-should-not-appear-in-file");
  });

  test("get returns undefined for an account never set", async () => {
    expect(await createWindowsKeychainBackend(tempDir()).get("nope")).toBeUndefined();
  });

  test("delete removes the stored credential", async () => {
    const dir = tempDir();
    const backend = createWindowsKeychainBackend(dir);
    await backend.set("openai", "sk-value");
    await backend.delete("openai");
    expect(await backend.get("openai")).toBeUndefined();
  });
});

describe("createWindowsKeychainBackend (mocked)", () => {
  test("isAvailable reflects the spawned process's exit code", async () => {
    const backend = createWindowsKeychainBackend(tempDir(), async () => ({
      stdout: "",
      stderr: "powershell not found",
      exitCode: 1,
    }));
    expect(await backend.isAvailable()).toBe(false);
  });

  test("set throws when the PowerShell encryption step fails", async () => {
    const backend = createWindowsKeychainBackend(tempDir(), async () => ({
      stdout: "",
      stderr: "access denied",
      exitCode: 1,
    }));
    await expect(backend.set("anthropic", "secret")).rejects.toThrow(/DPAPI/);
  });
});
