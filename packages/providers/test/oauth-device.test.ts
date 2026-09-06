import { describe, expect, test } from "bun:test";
import {
  clearRefreshInflight,
  getOAuthToken,
  OAUTH_PROVIDERS,
  pollDeviceToken,
  requestDeviceAuthorization,
  runDeviceFlow,
  supportsDeviceFlow,
} from "../src/auth/oauth.ts";
import type { KeychainBackend } from "../src/auth/types.ts";

function memoryKeychain(): KeychainBackend & { store: Map<string, string> } {
  const store = new Map<string, string>();
  return {
    name: "memory",
    isAvailable: async () => true,
    get: async (key: string) => store.get(key),
    set: async (key: string, value: string) => {
      store.set(key, value);
    },
    delete: async (key: string) => {
      store.delete(key);
    },
    store,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

const noSleep = async () => {};

describe("device flow opt-in", () => {
  test("github-copilot supports device flow, others do not", () => {
    expect(supportsDeviceFlow("github-copilot")).toBe(true);
    expect(supportsDeviceFlow("anthropic")).toBe(false);
    expect(supportsDeviceFlow("openai")).toBe(false);
    expect(supportsDeviceFlow("google")).toBe(false);
  });

  test("requestDeviceAuthorization throws AgencyError on placeholder clientId", async () => {
    const httpFetch = (async () => jsonResponse({})) as unknown as typeof fetch;
    const err = await requestDeviceAuthorization("anthropic", httpFetch).then(
      () => null,
      (e: unknown) => e as { code?: string; message?: string },
    );
    expect(err).not.toBeNull();
    expect(err?.code).toBe("auth");
    expect(err?.message).toContain('OAuth not configured for provider "anthropic"');
  });
});

describe("requestDeviceAuthorization", () => {
  test("posts client_id and scope, returns parsed fields", async () => {
    let seenUrl = "";
    let seenBody: Record<string, string> = {};
    const httpFetch = (async (url: unknown, init: unknown) => {
      seenUrl = String(url);
      seenBody = JSON.parse(String((init as { body: string }).body)) as Record<string, string>;
      return jsonResponse({
        device_code: "dev-123",
        user_code: "ABCD-1234",
        verification_uri: "https://github.com/login/device",
        verification_uri_complete: "https://github.com/login/device?user_code=ABCD-1234",
        expires_in: 900,
        interval: 5,
      });
    }) as unknown as typeof fetch;
    const res = await requestDeviceAuthorization("github-copilot", httpFetch, {
      clientId: "my-app-client-id",
    });
    expect(seenUrl).toBe("https://github.com/login/device/code");
    expect(seenBody.client_id).toBe("my-app-client-id");
    expect(typeof seenBody.scope).toBe("string");
    expect(res).toMatchObject({
      deviceCode: "dev-123",
      userCode: "ABCD-1234",
      verificationUri: "https://github.com/login/device",
      expiresIn: 900,
      interval: 5,
    });
  });
});

describe("pollDeviceToken", () => {
  const device = {
    deviceCode: "dev-123",
    userCode: "ABCD-1234",
    verificationUri: "https://github.com/login/device",
    expiresIn: 900,
    interval: 5,
  };

  test("poll success stores nothing but returns token", async () => {
    clearRefreshInflight();
    const calls: unknown[] = [];
    const httpFetch = (async (_url: unknown, init: unknown) => {
      calls.push(init);
      if (calls.length === 1) return jsonResponse({ error: "authorization_pending" });
      return jsonResponse({ access_token: "tok", refresh_token: "ref", expires_in: 3600 });
    }) as unknown as typeof fetch;
    const token = await pollDeviceToken("github-copilot", device, httpFetch, {
      clientId: "my-app-client-id",
      sleep: noSleep,
    });
    expect(token.accessToken).toBe("tok");
    expect(calls.length).toBe(2);
  });

  test("slow_down backs off the poll interval", async () => {
    clearRefreshInflight();
    const httpFetch = (async () => jsonResponse({ error: "slow_down" })) as unknown as typeof fetch;
    const sleeps: number[] = [];
    const sleeping = async (ms: number) => {
      sleeps.push(ms);
      throw new Error("stop-after-first-sleep");
    };
    await expect(
      pollDeviceToken("github-copilot", { ...device, interval: 5 }, httpFetch, {
        clientId: "my-app-client-id",
        sleep: sleeping,
      }),
    ).rejects.toThrow("stop-after-first-sleep");
    expect(sleeps).toEqual([10000]);
  });

  test("clamps a garbage server interval to 60s", async () => {
    clearRefreshInflight();
    const httpFetch = (async () =>
      jsonResponse({ error: "authorization_pending" })) as unknown as typeof fetch;
    const sleeps: number[] = [];
    const sleeping = async (ms: number) => {
      sleeps.push(ms);
      throw new Error("stop-after-first-sleep");
    };
    await expect(
      pollDeviceToken("github-copilot", { ...device, interval: 3600 }, httpFetch, {
        clientId: "my-app-client-id",
        sleep: sleeping,
      }),
    ).rejects.toThrow("stop-after-first-sleep");
    expect(sleeps).toEqual([60000]);
  });

  test("slow_down backoff cannot exceed 60s", async () => {
    clearRefreshInflight();
    const httpFetch = (async () => jsonResponse({ error: "slow_down" })) as unknown as typeof fetch;
    const sleeps: number[] = [];
    const sleeping = async (ms: number) => {
      sleeps.push(ms);
      throw new Error("stop-after-first-sleep");
    };
    await expect(
      pollDeviceToken("github-copilot", { ...device, interval: 58 }, httpFetch, {
        clientId: "my-app-client-id",
        sleep: sleeping,
      }),
    ).rejects.toThrow("stop-after-first-sleep");
    expect(sleeps).toEqual([60000]);
  });

  test("expired_token throws AgencyError", async () => {
    clearRefreshInflight();
    const httpFetch = (async () => jsonResponse({ error: "expired_token" })) as unknown as typeof fetch;
    await expect(
      pollDeviceToken("github-copilot", device, httpFetch, {
        clientId: "my-app-client-id",
        sleep: noSleep,
      }),
    ).rejects.toMatchObject({ code: "auth" });
  });

  test("access_denied throws AgencyError", async () => {
    clearRefreshInflight();
    const httpFetch = (async () => jsonResponse({ error: "access_denied" })) as unknown as typeof fetch;
    await expect(
      pollDeviceToken("github-copilot", device, httpFetch, {
        clientId: "my-app-client-id",
        sleep: noSleep,
      }),
    ).rejects.toMatchObject({ code: "auth" });
  });
});

describe("runDeviceFlow", () => {
  test("full flow stores token in the canonical oauth slot", async () => {
    clearRefreshInflight();
    const keychain = memoryKeychain();
    let pollCalls = 0;
    const httpFetch = (async (url: unknown) => {
      if (String(url).includes("/device/code")) {
        return jsonResponse({
          device_code: "dev-1",
          user_code: "CODE-1",
          verification_uri: "https://github.com/login/device",
          expires_in: 900,
          interval: 0,
        });
      }
      pollCalls++;
      if (pollCalls === 1) return jsonResponse({ error: "authorization_pending" });
      return jsonResponse({ access_token: "final", refresh_token: "r", expires_in: 3600 });
    }) as unknown as typeof fetch;
    const shown: Array<{ userCode: string; verificationUri: string }> = [];
    const token = await runDeviceFlow("github-copilot", keychain, {
      clientId: "my-app-client-id",
      httpFetch,
      sleep: noSleep,
      onUserCode: (info) => {
        shown.push(info);
      },
    });
    expect(token.accessToken).toBe("final");
    expect(shown).toEqual([{ userCode: "CODE-1", verificationUri: "https://github.com/login/device" }]);
    expect(await getOAuthToken(keychain, "github-copilot")).toMatchObject({ accessToken: "final" });
    expect(keychain.store.get("github-copilot:oauth")).toContain("final");
    expect(OAUTH_PROVIDERS["github-copilot"]!.tokenUrl).toContain("github.com");
  });
});
