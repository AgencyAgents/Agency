import { describe, expect, test } from "bun:test";
import { createMacosKeychainBackend } from "../../src/auth/macos.ts";
import type { SpawnFn } from "../../src/auth/types.ts";

function recordingSpawn(response: { stdout?: string; stderr?: string; exitCode?: number }) {
  const calls: string[][] = [];
  const spawn: SpawnFn = async (command) => {
    calls.push([...command]);
    return { stdout: response.stdout ?? "", stderr: response.stderr ?? "", exitCode: response.exitCode ?? 0 };
  };
  return { spawn, calls };
}

describe("createMacosKeychainBackend", () => {
  test("isAvailable checks that `security` runs successfully", async () => {
    const { spawn, calls } = recordingSpawn({ exitCode: 0 });
    expect(await createMacosKeychainBackend(spawn).isAvailable()).toBe(true);
    expect(calls[0]).toEqual(["security", "help"]);
  });

  test("set invokes add-generic-password with the account, service, and secret", async () => {
    const { spawn, calls } = recordingSpawn({ exitCode: 0 });
    await createMacosKeychainBackend(spawn).set("anthropic", "sk-ant-secret");

    expect(calls[0]).toEqual([
      "security",
      "add-generic-password",
      "-a",
      "anthropic",
      "-s",
      "agency",
      "-w",
      "sk-ant-secret",
      "-U",
    ]);
  });

  test("set throws when the security command fails", async () => {
    const { spawn } = recordingSpawn({ exitCode: 1, stderr: "denied" });
    await expect(createMacosKeychainBackend(spawn).set("anthropic", "x")).rejects.toThrow(/Keychain/);
  });

  test("get returns the trimmed stdout as the secret", async () => {
    const { spawn, calls } = recordingSpawn({ stdout: "sk-ant-secret\n", exitCode: 0 });
    expect(await createMacosKeychainBackend(spawn).get("anthropic")).toBe("sk-ant-secret");
    expect(calls[0]).toEqual(["security", "find-generic-password", "-a", "anthropic", "-s", "agency", "-w"]);
  });

  test("get returns undefined when the entry doesn't exist", async () => {
    const { spawn } = recordingSpawn({ exitCode: 44 }); // security's real "not found" code
    expect(await createMacosKeychainBackend(spawn).get("missing")).toBeUndefined();
  });

  test("delete invokes delete-generic-password for the right account", async () => {
    const { spawn, calls } = recordingSpawn({ exitCode: 0 });
    await createMacosKeychainBackend(spawn).delete("openai");
    expect(calls[0]).toEqual(["security", "delete-generic-password", "-a", "openai", "-s", "agency"]);
  });
});
