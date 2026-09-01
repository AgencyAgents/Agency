import { describe, expect, test } from "bun:test";
import {
  ConnectError,
  createHttpValidator,
  createScriptedPrompter,
  isValidProviderId,
  type KeyStore,
  runConnectFlow,
} from "../src/connect.ts";

/** Structural twin of the validator's http parameter; no @agency/net needed. */
type TestHttp = { fetch(url: string, init?: RequestInit): Promise<Response> };

function memoryKeyStore(): KeyStore & { secrets: Map<string, string> } {
  const secrets = new Map<string, string>();
  return {
    name: "memory",
    secrets,
    async set(account, secret) {
      secrets.set(account, secret);
    },
  };
}

describe("runConnectFlow", () => {
  test("prompts for id and key, validates, and stores in the keychain", async () => {
    const prompter = createScriptedPrompter(["anthropic", "sk-ant-secret"]);
    const keychain = memoryKeyStore();
    const validated: Array<[string, string]> = [];

    const outcome = await runConnectFlow({
      prompter,
      keychain,
      validate: async (providerId, apiKey) => {
        validated.push([providerId, apiKey]);
        return true;
      },
      knownProviders: ["anthropic", "openai"],
    });

    expect(outcome).toEqual({ providerId: "anthropic", storedIn: "memory", verified: true });
    expect(validated).toEqual([["anthropic", "sk-ant-secret"]]);
    expect(keychain.secrets.get("anthropic")).toBe("sk-ant-secret");
    // The provider prompt carries the known-provider suggestions.
    expect(prompter.asked[0]).toContain("anthropic");
  });

  test("strips an @ai-sdk/ prefix from a pasted package-style id", async () => {
    const prompter = createScriptedPrompter(["@ai-sdk/openai", "sk-x"]);
    const keychain = memoryKeyStore();

    const outcome = await runConnectFlow({ prompter, keychain, skipValidation: true });
    expect(outcome.providerId).toBe("openai");
    expect(keychain.secrets.get("openai")).toBe("sk-x");
  });

  test("an empty provider id aborts without storing anything", async () => {
    const prompter = createScriptedPrompter([""]);
    const keychain = memoryKeyStore();

    await expect(runConnectFlow({ prompter, keychain })).rejects.toThrow(ConnectError);
    expect(keychain.secrets.size).toBe(0);
  });

  test("an invalid provider id is rejected before any key is read", async () => {
    const prompter = createScriptedPrompter(["Bad Provider!"]);
    const keychain = memoryKeyStore();

    const error = await runConnectFlow({ prompter, keychain }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ConnectError);
    expect((error as ConnectError).code).toBe("invalid_id");
    expect(keychain.secrets.size).toBe(0);
    // Only the provider prompt was asked; the flow stopped there.
    expect(prompter.asked).toHaveLength(1);
  });

  test("an empty key aborts with the no_key code", async () => {
    const prompter = createScriptedPrompter(["openai", ""]);
    const keychain = memoryKeyStore();

    const error = await runConnectFlow({ prompter, keychain }).catch((e: unknown) => e);
    expect((error as ConnectError).code).toBe("no_key");
    expect(keychain.secrets.size).toBe(0);
  });

  test("a failed validation rejects the key and never stores it", async () => {
    const prompter = createScriptedPrompter(["openai", "sk-wrong"]);
    const keychain = memoryKeyStore();

    const error = await runConnectFlow({
      prompter,
      keychain,
      validate: async () => false,
    }).catch((e: unknown) => e);

    expect((error as ConnectError).code).toBe("rejected");
    expect(keychain.secrets.size).toBe(0);
  });

  test("skipValidation stores an unverified key", async () => {
    const prompter = createScriptedPrompter(["openai", "sk-offline"]);
    const keychain = memoryKeyStore();

    const outcome = await runConnectFlow({
      prompter,
      keychain,
      validate: async () => {
        throw new Error("validation must be skipped");
      },
      skipValidation: true,
    });
    expect(outcome.verified).toBe(false);
    expect(keychain.secrets.get("openai")).toBe("sk-offline");
  });
});

describe("createHttpValidator", () => {
  test("a 401 from the provider rejects the key", async () => {
    const http: TestHttp = { fetch: async () => new Response("no", { status: 401 }) };
    const validate = createHttpValidator(http);
    expect(await validate("openai", "sk-bad")).toBe(false);
  });

  test("a 403 rejects too, and the request carries the bearer key", async () => {
    let captured: Record<string, unknown> = {};
    const http: TestHttp = {
      fetch: async (_url, init) => {
        captured = (init?.headers ?? {}) as Record<string, unknown>;
        return new Response("no", { status: 403 });
      },
    };
    const validate = createHttpValidator(http);
    expect(await validate("openai", "sk-bad")).toBe(false);
    expect(captured.authorization).toBe("Bearer sk-bad");
  });

  test("anthropic pings with x-api-key headers", async () => {
    let capturedUrl = "";
    let capturedHeaders: Record<string, unknown> = {};
    const http: TestHttp = {
      fetch: async (url, init) => {
        capturedUrl = url;
        capturedHeaders = (init?.headers ?? {}) as Record<string, unknown>;
        return new Response("{}", { status: 200 });
      },
    };
    const validate = createHttpValidator(http);
    expect(await validate("anthropic", "sk-ant")).toBe(true);
    expect(capturedUrl).toBe("https://api.anthropic.com/v1/models");
    expect(capturedHeaders["x-api-key"]).toBe("sk-ant");
  });

  test("google pings with the key in the query string", async () => {
    let capturedUrl = "";
    const http: TestHttp = {
      fetch: async (url) => {
        capturedUrl = url;
        return new Response("{}", { status: 200 });
      },
    };
    const validate = createHttpValidator(http);
    expect(await validate("google", "g-key")).toBe(true);
    expect(capturedUrl).toContain("key=g-key");
  });

  test("a custom gateway is pinged at its own baseUrl", async () => {
    let capturedUrl = "";
    const http: TestHttp = {
      fetch: async (url) => {
        capturedUrl = url;
        return new Response("{}", { status: 200 });
      },
    };
    const validate = createHttpValidator(http, { "my-gateway": "http://localhost:8080/v1" });
    expect(await validate("my-gateway", "sk-g")).toBe(true);
    expect(capturedUrl).toBe("http://localhost:8080/v1/models");
  });

  test("an unknown provider with no baseUrl is inconclusive, not failed", async () => {
    let called = false;
    const http: TestHttp = {
      fetch: async () => {
        called = true;
        return new Response("{}", { status: 200 });
      },
    };
    const validate = createHttpValidator(http);
    expect(await validate("mystery-provider", "sk-x")).toBe(true);
    expect(called).toBe(false);
  });

  test("a network failure is inconclusive so the key can still be stored", async () => {
    const http: TestHttp = {
      fetch: async () => {
        throw new Error("offline");
      },
    };
    const validate = createHttpValidator(http);
    expect(await validate("openai", "sk-x")).toBe(true);
  });
});

describe("isValidProviderId", () => {
  test("accepts lowercase ids with digits, dashes, underscores", () => {
    expect(isValidProviderId("openai")).toBe(true);
    expect(isValidProviderId("my-gateway_2")).toBe(true);
  });

  test("rejects spaces, uppercase, and leading symbols", () => {
    expect(isValidProviderId("My Gateway")).toBe(false);
    expect(isValidProviderId("-leading")).toBe(false);
    expect(isValidProviderId("")).toBe(false);
  });
});
