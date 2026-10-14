import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SpawnFn } from "../../src/auth/types.ts";
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

const noSpawn: SpawnFn = async () => {
  throw new Error("no process may start");
};

// Real DPAPI through crypt32.dll: Windows only.
describe.skipIf(process.platform !== "win32")("createWindowsKeychainBackend (real DPAPI)", () => {
  test("is available on a Windows machine", async () => {
    expect(await createWindowsKeychainBackend(tempDir()).isAvailable()).toBe(true);
  });

  test("round-trips a secret, and set and get start no process", async () => {
    const backend = createWindowsKeychainBackend(tempDir(), noSpawn);
    await backend.set("anthropic", "sk-ant-real-dpapi-secret");
    expect(await backend.get("anthropic")).toBe("sk-ant-real-dpapi-secret");
  });

  test("the on-disk blob never contains the plaintext secret", async () => {
    const dir = tempDir();
    await createWindowsKeychainBackend(dir).set("anthropic", "sk-ant-should-not-appear-in-file");
    const raw = readFileSync(join(dir, "anthropic.dpapi"), "utf8");
    expect(raw).not.toContain("sk-ant-should-not-appear-in-file");
  });

  test("a key that the PowerShell path of an earlier version stored still reads", async () => {
    const dir = tempDir();
    const script = [
      "Add-Type -AssemblyName System.Security",
      "$bytes = [System.Text.Encoding]::UTF8.GetBytes('sk-from-powershell')",
      "$encrypted = [System.Security.Cryptography.ProtectedData]::Protect($bytes, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)",
      "[System.Convert]::ToBase64String($encrypted)",
    ].join("; ");
    const made = Bun.spawnSync(["powershell.exe", "-NoProfile", "-Command", script]);
    writeFileSync(join(dir, "openai.dpapi"), made.stdout.toString().trim());
    expect(await createWindowsKeychainBackend(dir, noSpawn).get("openai")).toBe("sk-from-powershell");
  }, 20_000);

  test("get returns undefined for an account never set, or a blob that DPAPI cannot open", async () => {
    const dir = tempDir();
    writeFileSync(join(dir, "broken.dpapi"), "AQAAANCMnd8bfZERDj3/g==\n");
    const backend = createWindowsKeychainBackend(dir, noSpawn);
    expect(await backend.get("nope")).toBeUndefined();
    expect(await backend.get("broken")).toBeUndefined();
  });

  test("delete removes the stored credential", async () => {
    const backend = createWindowsKeychainBackend(tempDir());
    await backend.set("openai", "sk-value");
    await backend.delete("openai");
    expect(await backend.get("openai")).toBeUndefined();
  });

  test("migrates a legacy hex credential to the current format on read", async () => {
    const dir = tempDir();
    const scripts: string[] = [];
    const backend = createWindowsKeychainBackend(dir, async (cmd) => {
      scripts.push(cmd[3] ?? "");
      return { stdout: "sk-migrated-secret\n", stderr: "", exitCode: 0 };
    });
    // Pre-upgrade blob: bare hex with the ConvertFrom-SecureString header.
    writeFileSync(join(dir, "anthropic.dpapi"), "76492d1116743f0423413b16050a5345aabbccdd\n");

    expect(await backend.get("anthropic")).toBe("sk-migrated-secret");
    expect(scripts).toHaveLength(1);
    expect(scripts[0]).toContain("ConvertTo-SecureString");
    // The file is in the current format now: the next read needs no process.
    expect(readFileSync(join(dir, "anthropic.dpapi"), "utf8")).not.toStartWith(
      "76492d1116743f0423413b16050a5345",
    );
    expect(await createWindowsKeychainBackend(dir, noSpawn).get("anthropic")).toBe("sk-migrated-secret");
  });
});

describe("createWindowsKeychainBackend (mocked)", () => {
  test("a legacy credential that cannot be migrated reports an actionable error", async () => {
    const dir = tempDir();
    const backend = createWindowsKeychainBackend(dir, async () => ({
      stdout: "",
      stderr: "cmdlet failed",
      exitCode: 1,
    }));
    writeFileSync(join(dir, "anthropic.dpapi"), "76492d1116743f0423413b16050a5345aabbccdd\n");

    await expect(backend.get("anthropic")).rejects.toThrow(/pre-upgrade.*store it again/s);
    // The unmigrated file is left untouched for a later attempt.
    expect(readFileSync(join(dir, "anthropic.dpapi"), "utf8").trim()).toBe(
      "76492d1116743f0423413b16050a5345aabbccdd",
    );
  });
});
