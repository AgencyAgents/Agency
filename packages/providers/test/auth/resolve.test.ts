import { describe, expect, test } from "bun:test";
import { resolveApiKey } from "../../src/auth/resolve.ts";
import type { KeychainBackend } from "../../src/auth/types.ts";

function fakeKeychain(stored?: string): KeychainBackend {
  return {
    name: "fake",
    isAvailable: async () => true,
    get: async () => stored,
    set: async () => {},
    delete: async () => {},
  };
}

describe("resolveApiKey", () => {
  test("a flag wins over every other source", async () => {
    const key = await resolveApiKey({
      provider: "anthropic",
      flag: "sk-from-flag",
      env: { AGENCY_ANTHROPIC_API_KEY: "sk-from-env" },
      keychain: fakeKeychain("sk-from-keychain"),
      config: "sk-from-config",
    });
    expect(key).toBe("sk-from-flag");
  });

  test("env wins over keychain and config when there's no flag", async () => {
    const key = await resolveApiKey({
      provider: "anthropic",
      env: { AGENCY_ANTHROPIC_API_KEY: "sk-from-env" },
      keychain: fakeKeychain("sk-from-keychain"),
      config: "sk-from-config",
    });
    expect(key).toBe("sk-from-env");
  });

  test("keychain wins over config when there's no flag or env", async () => {
    const key = await resolveApiKey({
      provider: "anthropic",
      env: {},
      keychain: fakeKeychain("sk-from-keychain"),
      config: "sk-from-config",
    });
    expect(key).toBe("sk-from-keychain");
  });

  test("config is the last resort", async () => {
    const key = await resolveApiKey({ provider: "anthropic", env: {}, config: "sk-from-config" });
    expect(key).toBe("sk-from-config");
  });

  test("returns undefined when nothing resolves", async () => {
    const key = await resolveApiKey({ provider: "anthropic", env: {} });
    expect(key).toBeUndefined();
  });

  test("the env var name is provider-specific and uppercased", async () => {
    const key = await resolveApiKey({
      provider: "openai",
      env: { AGENCY_OPENAI_API_KEY: "sk-openai", AGENCY_ANTHROPIC_API_KEY: "sk-anthropic" },
    });
    expect(key).toBe("sk-openai");
  });
});
