import { describe, expect, test, afterEach } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFileFallbackBackend } from "../../src/auth/file-fallback.ts";

const cleanup: string[] = [];
afterEach(() => {
  for (const dir of cleanup.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "agency-keychain-test-"));
  cleanup.push(dir);
  return dir;
}

describe("createFileFallbackBackend", () => {
  test("is always available", async () => {
    expect(await createFileFallbackBackend(tempDir()).isAvailable()).toBe(true);
  });

  test("round-trips a secret through set/get", async () => {
    const backend = createFileFallbackBackend(tempDir());
    await backend.set("anthropic", "sk-ant-real-secret");
    expect(await backend.get("anthropic")).toBe("sk-ant-real-secret");
  });

  test("get returns undefined for an account that was never set", async () => {
    expect(await createFileFallbackBackend(tempDir()).get("nope")).toBeUndefined();
  });

  test("delete removes a stored secret", async () => {
    const backend = createFileFallbackBackend(tempDir());
    await backend.set("openai", "sk-value");
    await backend.delete("openai");
    expect(await backend.get("openai")).toBeUndefined();
  });

  test("the encrypted file on disk never contains the plaintext secret", async () => {
    const dir = tempDir();
    await createFileFallbackBackend(dir).set("anthropic", "sk-ant-super-secret-do-not-leak");

    const files = readdirSync(dir);
    const encFile = files.find((f) => f.endsWith(".enc"));
    const raw = readFileSync(join(dir, encFile!), "utf8");

    expect(raw).not.toContain("sk-ant-super-secret-do-not-leak");
  });

  test("the key file is written with owner-only permissions", async () => {
    const dir = tempDir();
    await createFileFallbackBackend(dir).set("anthropic", "sk-value");
    const mode = statSync(join(dir, "fallback.key")).mode & 0o777;
    // Windows doesn't enforce POSIX mode bits the same way; only assert on POSIX.
    if (process.platform !== "win32") {
      expect(mode).toBe(0o600);
    }
  });

  test("two different accounts don't collide", async () => {
    const backend = createFileFallbackBackend(tempDir());
    await backend.set("anthropic", "key-a");
    await backend.set("openai", "key-b");
    expect(await backend.get("anthropic")).toBe("key-a");
    expect(await backend.get("openai")).toBe("key-b");
  });

  test("reuses the same encryption key across separate backend instances", async () => {
    const dir = tempDir();
    await createFileFallbackBackend(dir).set("anthropic", "sk-value");
    expect(await createFileFallbackBackend(dir).get("anthropic")).toBe("sk-value");
  });
});
