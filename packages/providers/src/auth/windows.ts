import { dlopen, FFIType, type Pointer, ptr, toArrayBuffer } from "bun:ffi";
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

let dpapi: ReturnType<typeof openDpapi> | undefined;

function openDpapi() {
  const call = {
    args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.u32, FFIType.ptr],
    returns: FFIType.i32,
  };
  return {
    crypt32: dlopen("crypt32.dll", { CryptProtectData: call, CryptUnprotectData: call }).symbols,
    kernel32: dlopen("kernel32.dll", { LocalFree: { args: [FFIType.ptr], returns: FFIType.ptr } }).symbols,
  };
}

/**
 * One DPAPI call with the scope of the current user, as `ProtectedData` of .NET makes it: the blobs of the two are
 * the same. A PowerShell process for this cost 430 ms on each read of a key.
 */
function runDpapi(fn: "CryptProtectData" | "CryptUnprotectData", input: Uint8Array): Uint8Array | undefined {
  dpapi ??= openDpapi();
  // DATA_BLOB: the size in 4 bytes, then the pointer at offset 8.
  const blob = new Uint8Array(16);
  new DataView(blob.buffer).setUint32(0, input.length, true);
  new DataView(blob.buffer).setBigUint64(8, BigInt(ptr(input)), true);
  const out = new Uint8Array(16);
  // CRYPTPROTECT_UI_FORBIDDEN: never a prompt.
  if (!dpapi.crypt32[fn](ptr(blob), null, null, null, null, 1, ptr(out))) return undefined;
  const view = new DataView(out.buffer);
  const data = Number(view.getBigUint64(8, true)) as Pointer;
  const result = new Uint8Array(toArrayBuffer(data, 0, view.getUint32(0, true))).slice();
  dpapi.kernel32.LocalFree(data);
  return result;
}

/**
 * Windows has no CLI for reading Credential Manager entries back out; only native Win32 APIs expose that. DPAPI
 * gives the same guarantee (encryption tied to the current Windows user account), so the ciphertext is in a file.
 */
export function createWindowsKeychainBackend(
  storeDir: string,
  spawn: SpawnFn = defaultSpawn,
): KeychainBackend {
  const backend: KeychainBackend = {
    name: "windows-dpapi",

    async isAvailable() {
      try {
        dpapi ??= openDpapi();
        return true;
      } catch {
        return false;
      }
    },

    async set(account, secret) {
      mkdirSync(storeDir, { recursive: true });
      const encrypted = runDpapi("CryptProtectData", new TextEncoder().encode(secret));
      if (encrypted === undefined) throw new Error("failed to encrypt credential via DPAPI");
      writeFileSync(accountFile(storeDir, account), Buffer.from(encrypted).toString("base64"));
    },

    async get(account) {
      const path = accountFile(storeDir, account);
      if (!existsSync(path)) return undefined;
      const encrypted = readFileSync(path, "utf8").trim();

      // Pre-upgrade credentials are in the legacy hex format; without this
      // branch they would fail to decode below and silently vanish.
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

      const bytes = Buffer.from(encrypted, "base64");
      if (bytes.length === 0) return undefined;
      const decrypted = runDpapi("CryptUnprotectData", bytes);
      return decrypted === undefined ? undefined : new TextDecoder().decode(decrypted);
    },

    async delete(account) {
      const path = accountFile(storeDir, account);
      if (existsSync(path)) rmSync(path);
    },
  };

  return backend;
}
