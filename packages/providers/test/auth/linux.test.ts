import { describe, expect, test } from "bun:test";
import { createLinuxKeychainBackend } from "../../src/auth/linux.ts";
import type { SpawnFn } from "../../src/auth/types.ts";

function recordingSpawn(response: { stdout?: string; stderr?: string; exitCode?: number }) {
  const calls: { command: string[]; stdin?: string }[] = [];
  const spawn: SpawnFn = async (command, options) => {
    calls.push({ command: [...command], stdin: options?.stdin });
    return { stdout: response.stdout ?? "", stderr: response.stderr ?? "", exitCode: response.exitCode ?? 0 };
  };
  return { spawn, calls };
}

describe("createLinuxKeychainBackend", () => {
  test("isAvailable checks that secret-tool runs successfully", async () => {
    const { spawn, calls } = recordingSpawn({ exitCode: 0 });
    expect(await createLinuxKeychainBackend(spawn).isAvailable()).toBe(true);
    expect(calls[0]!.command).toEqual(["secret-tool", "--version"]);
  });

  test("isAvailable is false when secret-tool isn't installed", async () => {
    const { spawn } = recordingSpawn({ exitCode: 127 });
    expect(await createLinuxKeychainBackend(spawn).isAvailable()).toBe(false);
  });

  test("set pipes the secret over stdin rather than as an argument", async () => {
    const { spawn, calls } = recordingSpawn({ exitCode: 0 });
    await createLinuxKeychainBackend(spawn).set("anthropic", "sk-ant-secret");

    expect(calls[0]!.command).toEqual([
      "secret-tool",
      "store",
      "--label",
      "Agency: anthropic",
      "service",
      "agency",
      "account",
      "anthropic",
    ]);
    expect(calls[0]!.stdin).toBe("sk-ant-secret");
    // The secret must never appear in the argv itself (visible via /proc/*/cmdline to other users).
    expect(calls[0]!.command.join(" ")).not.toContain("sk-ant-secret");
  });

  test("get looks up by service and account, returning trimmed stdout", async () => {
    const { spawn, calls } = recordingSpawn({ stdout: "sk-ant-secret\n", exitCode: 0 });
    expect(await createLinuxKeychainBackend(spawn).get("anthropic")).toBe("sk-ant-secret");
    expect(calls[0]!.command).toEqual(["secret-tool", "lookup", "service", "agency", "account", "anthropic"]);
  });

  test("get returns undefined when nothing is stored", async () => {
    const { spawn } = recordingSpawn({ exitCode: 1 });
    expect(await createLinuxKeychainBackend(spawn).get("missing")).toBeUndefined();
  });

  test("delete clears the entry for the right account", async () => {
    const { spawn, calls } = recordingSpawn({ exitCode: 0 });
    await createLinuxKeychainBackend(spawn).delete("openai");
    expect(calls[0]!.command).toEqual(["secret-tool", "clear", "service", "agency", "account", "openai"]);
  });
});
