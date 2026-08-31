import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { KeychainBackend, SpawnFn } from "./types.ts";
import { defaultSpawn } from "./types.ts";

function accountFile(dir: string, account: string): string {
  const safe = account.replace(/[^a-zA-Z0-9._-]/g, "_");
  return join(dir, `${safe}.dpapi`);
}

/**
 * Resolved by absolute path rather than PATH lookup: some shells (minimal
 * CI runners, restricted containers) don't have System32 on PATH at all,
 * and Windows PowerShell 5.1 always lives at this fixed location on every
 * supported Windows version.
 */
function powershellExecutable(): string {
  const systemRoot = process.env.SystemRoot ?? "C:\\Windows";
  return join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}

/**
 * Windows has no CLI for reading Credential Manager entries back out; only
 * native Win32 APIs expose that. DPAPI via PowerShell's
 * ConvertTo/FromSecureString gives the same guarantee Credential Manager
 * does (encryption tied to the current Windows user account) without a
 * native addon, so the ciphertext is stored in a plain file here instead.
 */
export function createWindowsKeychainBackend(
  storeDir: string,
  spawn: SpawnFn = defaultSpawn,
): KeychainBackend {
  return {
    name: "windows-dpapi",

    async isAvailable() {
      const result = await spawn([powershellExecutable(), "-NoProfile", "-Command", "$true"]);
      return result.exitCode === 0;
    },

    async set(account, secret) {
      mkdirSync(storeDir, { recursive: true });
      const script = [
        "$secret = [Console]::In.ReadLine()",
        "$secure = ConvertTo-SecureString -String $secret -AsPlainText -Force",
        "ConvertFrom-SecureString -SecureString $secure",
      ].join("; ");

      const result = await spawn([powershellExecutable(), "-NoProfile", "-Command", script], {
        stdin: `${secret}\n`,
      });
      if (result.exitCode !== 0) {
        throw new Error(`failed to encrypt credential via DPAPI: ${result.stderr}`);
      }
      writeFileSync(accountFile(storeDir, account), result.stdout.trim());
    },

    async get(account) {
      const path = accountFile(storeDir, account);
      if (!existsSync(path)) return undefined;
      const encrypted = readFileSync(path, "utf8").trim();

      const script = [
        "$encrypted = [Console]::In.ReadLine()",
        "$secure = ConvertTo-SecureString -String $encrypted",
        "$bstr = [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)",
        "[System.Runtime.InteropServices.Marshal]::PtrToStringAuto($bstr)",
      ].join("; ");

      const result = await spawn([powershellExecutable(), "-NoProfile", "-Command", script], {
        stdin: `${encrypted}\n`,
      });
      if (result.exitCode !== 0) return undefined;
      return result.stdout.trim();
    },

    async delete(account) {
      const path = accountFile(storeDir, account);
      if (existsSync(path)) rmSync(path);
    },
  };
}
