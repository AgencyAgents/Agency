import { describe, expect, test } from "bun:test";
import {
  buildAuthorizeUrl,
  exchangeCodeForToken,
  generatePkcePair,
  getOAuthToken,
  OAUTH_PROVIDERS,
  oauthKey,
  refreshOAuthToken,
  resolveOAuthConfig,
  resolveProviderOAuthConfig,
  storeOAuthToken,
} from "../src/auth/oauth.ts";
import { resolveApiKey } from "../src/auth/resolve.ts";
import type { KeychainBackend } from "../src/auth/types.ts";

// ---------------------------------------------------------------------------
// Real endpoint registry — verify every provider has real, non-placeholder URLs
// ---------------------------------------------------------------------------
describe("OAuth real endpoint registry", () => {
  const expectedProviders = ["anthropic", "openai", "google", "github-copilot"];

  test.each(expectedProviders)("%s has a real authorizeUrl", (provider) => {
    const config = OAUTH_PROVIDERS[provider]!;
    expect(config).toBeDefined();
    expect(config.authorizeUrl).toBeTruthy();
    // Must be a valid HTTPS URL (or HTTP for localhost in dev)
    const url = new URL(config.authorizeUrl);
    expect(url.protocol).toBe("https:");
    expect(url.hostname).not.toBe("");
  });

  test.each(expectedProviders)("%s has a real tokenUrl", (provider) => {
    const config = OAUTH_PROVIDERS[provider]!;
    expect(config).toBeDefined();
    expect(config.tokenUrl).toBeTruthy();
    const url = new URL(config.tokenUrl);
    expect(url.protocol).toBe("https:");
    expect(url.hostname).not.toBe("");
  });

  test.each(expectedProviders)("%s has scopes defined", (provider) => {
    const config = OAUTH_PROVIDERS[provider]!;
    expect(config.scopes).toBeInstanceOf(Array);
    expect(config.scopes.length).toBeGreaterThan(0);
  });

  test("anthropic endpoints are correct", () => {
    const config = OAUTH_PROVIDERS.anthropic!;
    expect(config.authorizeUrl).toBe("https://console.anthropic.com/oauth/authorize");
    expect(config.tokenUrl).toBe("https://console.anthropic.com/oauth/token");
    expect(config.scopes).toEqual(["user:inference"]);
  });

  test("openai endpoints are correct", () => {
    const config = OAUTH_PROVIDERS.openai!;
    expect(config.authorizeUrl).toBe("https://auth.openai.com/authorize");
    expect(config.tokenUrl).toBe("https://auth.openai.com/api/oauth/token");
    expect(config.scopes).toEqual(["openai.api.request"]);
  });

  test("google endpoints are correct", () => {
    const config = OAUTH_PROVIDERS.google!;
    expect(config.authorizeUrl).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(config.tokenUrl).toBe("https://oauth2.googleapis.com/token");
    expect(config.scopes).toEqual(["https://www.googleapis.com/auth/generative-language.retrieve"]);
  });

  test("github-copilot endpoints are correct", () => {
    const config = OAUTH_PROVIDERS["github-copilot"]!;
    expect(config.authorizeUrl).toBe("https://github.com/login/oauth/authorize");
    expect(config.tokenUrl).toBe("https://github.com/login/oauth/access_token");
    expect(config.scopes).toEqual(["copilot"]);
  });
});

// ---------------------------------------------------------------------------
// resolveOAuthConfig — baseUrl override support
// ---------------------------------------------------------------------------
describe("resolveOAuthConfig", () => {
  test("returns config unchanged when baseUrl is not set", () => {
    const config = OAUTH_PROVIDERS.anthropic!;
    const resolved = resolveOAuthConfig(config);
    expect(resolved).toBe(config); // same reference when no baseUrl
    expect(resolved.authorizeUrl).toBe(config.authorizeUrl);
    expect(resolved.tokenUrl).toBe(config.tokenUrl);
  });

  test("derives authorizeUrl and tokenUrl from baseUrl when set", () => {
    const config = { ...OAUTH_PROVIDERS.anthropic!, baseUrl: "https://my-proxy.example.com" };
    const resolved = resolveOAuthConfig(config);
    expect(resolved.authorizeUrl).toBe("https://my-proxy.example.com/authorize");
    expect(resolved.tokenUrl).toBe("https://my-proxy.example.com/token");
    // Other fields preserved
    expect(resolved.clientId).toBe(config.clientId);
    expect(resolved.scopes).toEqual(config.scopes);
  });

  test("strips trailing slash from baseUrl", () => {
    const config = { ...OAUTH_PROVIDERS.openai!, baseUrl: "https://gateway.example.com/" };
    const resolved = resolveOAuthConfig(config);
    expect(resolved.authorizeUrl).toBe("https://gateway.example.com/authorize");
    expect(resolved.tokenUrl).toBe("https://gateway.example.com/token");
  });

  test("works with all providers when baseUrl is set", () => {
    for (const key of Object.keys(OAUTH_PROVIDERS)) {
      const config = { ...OAUTH_PROVIDERS[key]!, baseUrl: "https://custom.example.com" };
      const resolved = resolveOAuthConfig(config);
      expect(resolved.authorizeUrl).toBe("https://custom.example.com/authorize");
      expect(resolved.tokenUrl).toBe("https://custom.example.com/token");
    }
  });
});

// ---------------------------------------------------------------------------
// buildAuthorizeUrl — uses resolved config
// ---------------------------------------------------------------------------
describe("buildAuthorizeUrl with resolved config", () => {
  test("uses resolved authorizeUrl when baseUrl is set", () => {
    const config = { ...OAUTH_PROVIDERS.anthropic!, baseUrl: "https://my-proxy.example.com" };
    const pkce = generatePkcePair();
    const url = buildAuthorizeUrl(config, {
      redirectUri: "http://localhost:12345/callback",
      state: "test-state",
      challenge: pkce.challenge,
    });
    expect(url).toContain("https://my-proxy.example.com/authorize");
    expect(url).toContain("client_id=agency-anthropic-oauth");
    expect(url).toContain("code_challenge_method=S256");
  });

  test("uses default authorizeUrl when no baseUrl", () => {
    const pkce = generatePkcePair();
    const url = buildAuthorizeUrl(OAUTH_PROVIDERS.anthropic!, {
      redirectUri: "http://localhost:12345/callback",
      state: "test-state",
      challenge: pkce.challenge,
    });
    expect(url).toContain("https://console.anthropic.com/oauth/authorize");
  });
});

// ---------------------------------------------------------------------------
// Placeholder clientId detection — all providers
// ---------------------------------------------------------------------------
describe("OAuth placeholder clientId detection", () => {
  test.each(["anthropic", "openai", "google", "github-copilot"])(
    "exchangeCodeForToken throws AgencyError for %s placeholder",
    async (provider) => {
      const config = OAUTH_PROVIDERS[provider]!;
      // Verify the current clientId is indeed a placeholder
      expect(config.clientId).toMatch(/^agency-/);

      try {
        await exchangeCodeForToken(provider, "code", "verifier", "http://localhost/callback");
        // Should not reach here
        expect(true).toBe(false);
      } catch (error: unknown) {
        const err = error as { code?: string; message?: string };
        expect(err.code).toBe("auth");
        expect(err.message).toContain(`OAuth not configured for provider "${provider}"`);
        expect(err.message).toContain("register an OAuth app");
      }
    },
  );

  test.each(["anthropic", "openai", "google", "github-copilot"])(
    "refreshOAuthToken throws AgencyError for %s placeholder",
    async (provider) => {
      const mockKeychain: KeychainBackend = {
        name: "mock",
        isAvailable: async () => true,
        get: async () =>
          JSON.stringify({
            type: "oauth",
            accessToken: "expired-token",
            refreshToken: "refresh-token",
            expiresAt: 0,
          }),
        set: async () => {},
        delete: async () => {},
      };

      try {
        await refreshOAuthToken(mockKeychain, provider);
        expect(true).toBe(false);
      } catch (error: unknown) {
        const err = error as { code?: string; message?: string };
        expect(err.code).toBe("auth");
        expect(err.message).toContain(`OAuth not configured for provider "${provider}"`);
      }
    },
  );

  test("exchangeCodeForToken throws Error for unknown provider", async () => {
    try {
      await exchangeCodeForToken("nonexistent", "code", "verifier", "http://localhost/callback");
      expect(true).toBe(false);
    } catch (error: unknown) {
      const err = error as Error;
      expect(err.message).toContain("Unknown OAuth provider");
    }
  });
});

// ---------------------------------------------------------------------------
// Provider count — ensure we have the expected set
// ---------------------------------------------------------------------------
describe("OAuth provider registry completeness", () => {
  test("has exactly 4 providers", () => {
    expect(Object.keys(OAUTH_PROVIDERS)).toEqual(["anthropic", "openai", "google", "github-copilot"]);
  });
});

function memoryKeychain(seed: Record<string, string> = {}): KeychainBackend & { store: Map<string, string> } {
  const store = new Map(Object.entries(seed));
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

function expiredOAuthJson(): string {
  return JSON.stringify({
    type: "oauth",
    accessToken: "stale-token",
    refreshToken: "refresh-token",
    expiresAt: 0,
  });
}

describe("resolveProviderOAuthConfig", () => {
  test("returns the registry entry when no overrides are given", () => {
    const resolved = resolveProviderOAuthConfig("anthropic");
    expect(resolved.clientId).toBe(OAUTH_PROVIDERS.anthropic!.clientId);
    expect(resolved.authorizeUrl).toBe(OAUTH_PROVIDERS.anthropic!.authorizeUrl);
  });

  test("a configured clientId replaces the shipped placeholder", () => {
    const resolved = resolveProviderOAuthConfig("anthropic", { clientId: "my-app-client-id" });
    expect(resolved.clientId).toBe("my-app-client-id");
    expect(resolved.authorizeUrl).toBe(OAUTH_PROVIDERS.anthropic!.authorizeUrl);
  });

  test("a configured baseUrl re-derives the endpoints", () => {
    const resolved = resolveProviderOAuthConfig("openai", { baseUrl: "https://gateway.example.com/" });
    expect(resolved.tokenUrl).toBe("https://gateway.example.com/token");
    expect(resolved.authorizeUrl).toBe("https://gateway.example.com/authorize");
  });

  test("throws for an unknown provider", () => {
    expect(() => resolveProviderOAuthConfig("nope")).toThrow("Unknown OAuth provider");
  });

  test("exchangeCodeForToken honors a configured clientId instead of the placeholder assert", async () => {
    const httpFetch = (async () =>
      new Response(JSON.stringify({ access_token: "fresh", refresh_token: "r", expires_in: 3600 }), {
        status: 200,
      })) as unknown as typeof fetch;
    const token = await exchangeCodeForToken(
      "anthropic",
      "code",
      "verifier",
      "http://localhost/callback",
      httpFetch,
      {
        clientId: "my-app-client-id",
      },
    );
    expect(token.accessToken).toBe("fresh");
  });
});

describe("refreshOAuthToken failure surfaces (no fail-open)", () => {
  test("a non-ok refresh throws instead of returning the stale token", async () => {
    const keychain = memoryKeychain({ [oauthKey("anthropic")]: expiredOAuthJson() });
    const httpFetch = (async () => new Response("denied", { status: 401 })) as unknown as typeof fetch;
    const error = await refreshOAuthToken(keychain, "anthropic", httpFetch, {
      clientId: "my-app-client-id",
    }).then(
      () => null,
      (e: unknown) => e as { code?: string; message?: string },
    );
    expect(error).not.toBeNull();
    expect(error?.code).toBe("auth");
    expect(error?.message).toContain("agency auth login anthropic --oauth");
  });

  test("a refresh with no access_token throws instead of returning the stale token", async () => {
    const keychain = memoryKeychain({ [oauthKey("anthropic")]: expiredOAuthJson() });
    const httpFetch = (async () =>
      new Response(JSON.stringify({}), { status: 200 })) as unknown as typeof fetch;
    await expect(
      refreshOAuthToken(keychain, "anthropic", httpFetch, { clientId: "my-app-client-id" }),
    ).rejects.toMatchObject({ code: "auth" });
  });

  test("a network failure throws instead of returning the stale token", async () => {
    const keychain = memoryKeychain({ [oauthKey("anthropic")]: expiredOAuthJson() });
    const httpFetch = (async () => {
      throw new Error("offline");
    }) as unknown as typeof fetch;
    await expect(
      refreshOAuthToken(keychain, "anthropic", httpFetch, { clientId: "my-app-client-id" }),
    ).rejects.toMatchObject({ code: "auth" });
  });

  test("a successful refresh stores and returns the new access token", async () => {
    const keychain = memoryKeychain({ [oauthKey("openai")]: expiredOAuthJson() });
    const httpFetch = (async () =>
      new Response(
        JSON.stringify({ access_token: "new-token", refresh_token: "new-refresh", expires_in: 3600 }),
        {
          status: 200,
        },
      )) as unknown as typeof fetch;
    const access = await refreshOAuthToken(keychain, "openai", httpFetch, { clientId: "my-app-client-id" });
    expect(access).toBe("new-token");
    expect(await getOAuthToken(keychain, "openai")).toMatchObject({ accessToken: "new-token" });
  });
});

describe("single canonical oauth key slot", () => {
  test("oauthKey is <provider>:oauth and store/get round-trip through it", async () => {
    expect(oauthKey("google")).toBe("google:oauth");
    const keychain = memoryKeychain();
    await storeOAuthToken(keychain, "google", {
      type: "oauth",
      accessToken: "tok",
      refreshToken: "ref",
      expiresAt: Date.now() + 3600_000,
    });
    expect(keychain.store.get("google:oauth")).toContain("tok");
    expect(await getOAuthToken(keychain, "google")).toMatchObject({ accessToken: "tok" });
  });

  test("resolveApiKey reads the canonical oauth slot", async () => {
    const keychain = memoryKeychain({
      [oauthKey("google")]: JSON.stringify({
        type: "oauth",
        accessToken: "fresh-token",
        refreshToken: "ref",
        expiresAt: Date.now() + 3600_000,
      }),
    });
    const key = await resolveApiKey({ provider: "google", env: {}, keychain });
    expect(key).toBe("fresh-token");
  });
});
