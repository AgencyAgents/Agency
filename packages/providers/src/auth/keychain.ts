import { createFileFallbackBackend } from "./file-fallback.ts";
import { createLinuxKeychainBackend } from "./linux.ts";
import { createMacosKeychainBackend } from "./macos.ts";
import type { KeychainBackend, SpawnFn } from "./types.ts";
import { createWindowsKeychainBackend } from "./windows.ts";

/** Picks the native backend for the current OS, falling back to an encrypted
 *  file when the native one isn't reachable (e.g. secret-tool missing on a
 *  headless Linux box). */
export async function createKeychain(
  platform: string,
  storeDir: string,
  spawn?: SpawnFn,
): Promise<KeychainBackend> {
  const native =
    platform === "win32"
      ? createWindowsKeychainBackend(storeDir, spawn)
      : platform === "darwin"
        ? createMacosKeychainBackend(spawn)
        : createLinuxKeychainBackend(spawn);

  if (await native.isAvailable()) return native;
  return createFileFallbackBackend(storeDir);
}
