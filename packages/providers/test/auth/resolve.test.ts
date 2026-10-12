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

  test("a variable name that the config declares wins over the built-in names", async () => {
    const key = await resolveApiKey({
      provider: "openrouter",
      declaredEnv: ["MY_ROUTER_KEY"],
      env: {
        MY_ROUTER_KEY: "sk-declared",
        AGENCY_OPENROUTER_API_KEY: "sk-agency",
        OPENROUTER_API_KEY: "sk-own",
      },
    });
    expect(key).toBe("sk-declared");
  });

  test("the provider's own variable name is read after the AGENCY name", async () => {
    const own = { OPENROUTER_API_KEY: "sk-own" };
    expect(await resolveApiKey({ provider: "openrouter", env: own })).toBe("sk-own");
    expect(
      await resolveApiKey({
        provider: "openrouter",
        env: { ...own, AGENCY_OPENROUTER_API_KEY: "sk-agency" },
      }),
    ).toBe("sk-agency");
    expect(
      await resolveApiKey({ provider: "openrouter", env: own, keychain: fakeKeychain("sk-stored") }),
    ).toBe("sk-own");
    expect(await resolveApiKey({ provider: "google", env: { GEMINI_API_KEY: "sk-gemini" } })).toBe(
      "sk-gemini",
    );
  });
});
