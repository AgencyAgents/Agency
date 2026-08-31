import type { KeychainBackend, SpawnFn } from "./types.ts";
import { defaultSpawn } from "./types.ts";

const SERVICE = "agency";

/** Shells out to the `security` CLI, present on every macOS install. */
export function createMacosKeychainBackend(spawn: SpawnFn = defaultSpawn): KeychainBackend {
  return {
    name: "macos-keychain",

    async isAvailable() {
      const result = await spawn(["security", "help"]);
      return result.exitCode === 0;
    },

    async set(account, secret) {
      const result = await spawn([
        "security",
        "add-generic-password",
        "-a",
        account,
        "-s",
        SERVICE,
        "-w",
        secret,
        "-U", // update in place if it already exists
      ]);
      if (result.exitCode !== 0) {
        throw new Error(`failed to store credential in macOS Keychain: ${result.stderr}`);
      }
    },

    async get(account) {
      const result = await spawn(["security", "find-generic-password", "-a", account, "-s", SERVICE, "-w"]);
      if (result.exitCode !== 0) return undefined;
      return result.stdout.trim();
    },

    async delete(account) {
      await spawn(["security", "delete-generic-password", "-a", account, "-s", SERVICE]);
    },
  };
}
