import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { KeychainBackend, SpawnFn } from "./types.ts";
import { defaultSpawn } from "./types.ts";

function accountFile(dir: string, account: string): string {
  const safe = account.replace(/[^a-zA-Z0-9._-]/g, "_");
  return join(dir, `${safe}.dpapi`);
}

/**
 * ConvertFrom-SecureString output — what `set` wrote before the switch to
 * ProtectedData + Base64 — is a bare hex blob that always begins with this
 * fixed format GUID, so it can be told apart from a Base64 DPAPI blob (which
 * never starts with it).
 */
const LEGACY_SECURE_STRING_HEADER = "76492d1116743f0423413b16050a5345";

function isLegacySecureStringBlob(blob: string): boolean {
  return blob.toLowerCase().startsWith(LEGACY_SECURE_STRING_HEADER) && /^[0-9a-fA-F]+$/.test(blob);
}

/** Decrypts a legacy ConvertFrom-SecureString blob through the old cmdlet path. */
async function decryptLegacySecureString(blob: string, spawn: SpawnFn): Promise<string | undefined> {
  const script = [
    "$encrypted = [Console]::In.ReadLine()",
    "$secure = ConvertTo-SecureString -String $encrypted",
    "$bstr = [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)",
    "[System.Runtime.InteropServices.Marshal]::PtrToStringUni($bstr)",
  ].join("; ");

  const result = await spawn([powershellExecutable(), "-NoProfile", "-Command", script], {
    stdin: `${blob}\n`,
  });
  return result.exitCode === 0 ? result.stdout.trim() : undefined;
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
  const backend: KeychainBackend = {
    name: "windows-dpapi",

    async isAvailable() {
      const result = await spawn([powershellExecutable(), "-NoProfile", "-Command", "$true"]);
      return result.exitCode === 0;
    },

    async set(account, secret) {
      mkdirSync(storeDir, { recursive: true });
      // Use .NET ProtectedData directly (System.Security.Cryptography) instead
      // of the PowerShell ConvertTo/ConvertFrom-SecureString cmdlets, which
      // require the Microsoft.PowerShell.Security module that may not load
      // reliably on some CI runners.
      const script = [
        "Add-Type -AssemblyName System.Security",
        "$secret = [Console]::In.ReadLine()",
        "$bytes = [System.Text.Encoding]::UTF8.GetBytes($secret)",
        "$encrypted = [System.Security.Cryptography.ProtectedData]::Protect($bytes, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)",
        "[System.Convert]::ToBase64String($encrypted)",
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

      // Pre-upgrade credentials are in the legacy hex format; without this
      // branch they would fail FromBase64String below and silently vanish.
      // Decrypt through the legacy cmdlet path once, rewrite the file in the
      // current format, and return the secret — a lazy one-time migration.
      if (isLegacySecureStringBlob(encrypted)) {
        const secret = await decryptLegacySecureString(encrypted, spawn);
        if (secret === undefined) {
          throw new Error(
            `credential "${account}" uses the pre-upgrade DPAPI hex format and could not be decrypted; run \`agency auth\` (or /connect) to store it again`,
          );
        }
        await backend.set(account, secret);
        return secret;
      }

      const script = [
        "Add-Type -AssemblyName System.Security",
        "$encrypted = [Console]::In.ReadLine()",
        "$bytes = [System.Convert]::FromBase64String($encrypted)",
        "$decrypted = [System.Security.Cryptography.ProtectedData]::Unprotect($bytes, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)",
        "[System.Text.Encoding]::UTF8.GetString($decrypted)",
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

  return backend;
}
