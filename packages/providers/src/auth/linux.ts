import type { KeychainBackend, SpawnFn } from "./types.ts";
import { defaultSpawn } from "./types.ts";

const SERVICE = "agency";

/**
 * Shells out to `secret-tool` (libsecret-tools), the CLI for the same
 * keyring GNOME/KDE apps use. Not present on every Linux install: headless
 * servers commonly lack it, which is exactly why the encrypted-file fallback
 * exists.
 */
export function createLinuxKeychainBackend(spawn: SpawnFn = defaultSpawn): KeychainBackend {
  return {
    name: "linux-secret-service",

    async isAvailable() {
      try {
        const result = await spawn(["secret-tool", "--version"]);
        return result.exitCode === 0;
      } catch {
        return false;
      }
    },

    async set(account, secret) {
      const result = await spawn(
        ["secret-tool", "store", "--label", `Agency: ${account}`, "service", SERVICE, "account", account],
        { stdin: secret },
      );
      if (result.exitCode !== 0) {
        throw new Error(`failed to store credential via secret-tool: ${result.stderr}`);
      }
    },

    async get(account) {
      const result = await spawn(["secret-tool", "lookup", "service", SERVICE, "account", account]);
      if (result.exitCode !== 0) return undefined;
      return result.stdout.trim();
    },

    async delete(account) {
      await spawn(["secret-tool", "clear", "service", SERVICE, "account", account]);
    },
  };
}
