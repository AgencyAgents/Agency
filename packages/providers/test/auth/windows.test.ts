import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

// Real DPAPI round-trip via powershell.exe; only meaningful on Windows, and
// exercises the actual subprocess path this backend uses in production.
// PowerShell 5.1's cold start is slow and variable (300ms-2s+), and several
// of these tests spawn it twice (set + get), so the default 5s test timeout
// isn't reliable margin: each test gets an explicit, longer one.
const DPAPI_TEST_TIMEOUT_MS = 20_000;

describe.skipIf(process.platform !== "win32")("createWindowsKeychainBackend (real DPAPI)", () => {
  test(
    "is available on a Windows machine with PowerShell",
    async () => {
      expect(await createWindowsKeychainBackend(tempDir()).isAvailable()).toBe(true);
    },
    DPAPI_TEST_TIMEOUT_MS,
  );

  test(
    "round-trips a secret through actual DPAPI encryption",
    async () => {
      const backend = createWindowsKeychainBackend(tempDir());
      await backend.set("anthropic", "sk-ant-real-dpapi-secret");
      expect(await backend.get("anthropic")).toBe("sk-ant-real-dpapi-secret");
    },
    DPAPI_TEST_TIMEOUT_MS,
  );

  test(
    "the on-disk blob never contains the plaintext secret",
    async () => {
      const dir = tempDir();
      await createWindowsKeychainBackend(dir).set("anthropic", "sk-ant-should-not-appear-in-file");
      const raw = readFileSync(join(dir, "anthropic.dpapi"), "utf8");
      expect(raw).not.toContain("sk-ant-should-not-appear-in-file");
    },
    DPAPI_TEST_TIMEOUT_MS,
  );

  test(
    "get returns undefined for an account never set",
    async () => {
      expect(await createWindowsKeychainBackend(tempDir()).get("nope")).toBeUndefined();
    },
    DPAPI_TEST_TIMEOUT_MS,
  );

  test(
    "delete removes the stored credential",
    async () => {
      const dir = tempDir();
      const backend = createWindowsKeychainBackend(dir);
      await backend.set("openai", "sk-value");
      await backend.delete("openai");
      expect(await backend.get("openai")).toBeUndefined();
    },
    DPAPI_TEST_TIMEOUT_MS,
  );
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

  test("migrates a legacy hex credential to the current format on read", async () => {
    const dir = tempDir();
    const scripts: string[] = [];
    const backend = createWindowsKeychainBackend(dir, async (cmd) => {
      const script = cmd[3] ?? "";
      scripts.push(script);
      // The legacy decrypt path and the current re-encrypt path are distinct scripts.
      if (script.includes("ConvertTo-SecureString")) {
        return { stdout: "sk-migrated-secret\n", stderr: "", exitCode: 0 };
      }
      return { stdout: "bmV3LWNpcGhlcnRleHQ==\n", stderr: "", exitCode: 0 };
    });

    // Pre-upgrade blob: bare hex with the ConvertFrom-SecureString header.
    writeFileSync(join(dir, "anthropic.dpapi"), "76492d1116743f0423413b16050a5345aabbccdd\n");

    expect(await backend.get("anthropic")).toBe("sk-migrated-secret");
    // The credential file has been rewritten in the current Base64 format, so
    // the legacy decrypt path never needs to run again.
    expect(readFileSync(join(dir, "anthropic.dpapi"), "utf8").trim()).toBe("bmV3LWNpcGhlcnRleHQ==");
    expect(scripts).toHaveLength(2);
  });

  test("a current-format credential is not routed through the legacy path", async () => {
    const dir = tempDir();
    const scripts: string[] = [];
    const backend = createWindowsKeychainBackend(dir, async (cmd) => {
      scripts.push(cmd[3] ?? "");
      return { stdout: "sk-plain-secret\n", stderr: "", exitCode: 0 };
    });

    writeFileSync(join(dir, "anthropic.dpapi"), "AQAAANCMnd8bfZERDj3/g==\n");

    expect(await backend.get("anthropic")).toBe("sk-plain-secret");
    expect(scripts).toHaveLength(1);
    expect(scripts[0]).not.toContain("ConvertTo-SecureString");
  });

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
