import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes, createCipheriv, createDecipheriv } from "node:crypto";
import type { KeychainBackend } from "./types.ts";

const ALGORITHM = "aes-256-gcm";

function accountFile(dir: string, account: string): string {
  const safe = account.replace(/[^a-zA-Z0-9._-]/g, "_");
  return join(dir, `${safe}.enc`);
}

function loadOrCreateKey(keyPath: string): Buffer {
  if (existsSync(keyPath)) return Buffer.from(readFileSync(keyPath, "utf8"), "hex");
  const key = randomBytes(32);
  mkdirSync(join(keyPath, ".."), { recursive: true });
  writeFileSync(keyPath, key.toString("hex"), { mode: 0o600 });
  return key;
}

/**
 * Last-resort backend for a platform with no native secret store reachable
 * (no `security`, no `secret-tool`, DPAPI unavailable). Encrypts with a
 * locally generated key restricted to the owner (0600) — real protection
 * against another user or a casual file read, but not against an attacker
 * who already has this account's own file-read access. That's the honest
 * ceiling of any keychain-less fallback, not a workaround for it.
 */
export function createFileFallbackBackend(storeDir: string): KeychainBackend {
  const keyPath = join(storeDir, "fallback.key");

  return {
    name: "file-fallback",

    async isAvailable() {
      return true;
    },

    async set(account, secret) {
      mkdirSync(storeDir, { recursive: true });
      const key = loadOrCreateKey(keyPath);
      const iv = randomBytes(12);
      const cipher = createCipheriv(ALGORITHM, key, iv);
      const ciphertext = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
      const authTag = cipher.getAuthTag();

      const payload = { iv: iv.toString("hex"), authTag: authTag.toString("hex"), data: ciphertext.toString("hex") };
      writeFileSync(accountFile(storeDir, account), JSON.stringify(payload), { mode: 0o600 });
    },

    async get(account) {
      const path = accountFile(storeDir, account);
      if (!existsSync(path) || !existsSync(keyPath)) return undefined;

      const key = loadOrCreateKey(keyPath);
      const payload = JSON.parse(readFileSync(path, "utf8")) as { iv: string; authTag: string; data: string };
      const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(payload.iv, "hex"));
      decipher.setAuthTag(Buffer.from(payload.authTag, "hex"));
      const plaintext = Buffer.concat([decipher.update(Buffer.from(payload.data, "hex")), decipher.final()]);
      return plaintext.toString("utf8");
    },

    async delete(account) {
      const path = accountFile(storeDir, account);
      if (existsSync(path)) rmSync(path);
    },
  };
}
