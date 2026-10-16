import { describe, expect, test } from "bun:test";
import { generateKeyPairSync, sign } from "node:crypto";
import { type AgencyError, ErrorCode } from "@agency/schema";
import {
  chatgptAccessToken,
  getChatgptCredential,
  listChatgptModels,
  signInChatgpt,
  signOutChatgpt,
  verifyIdToken,
} from "../../src/auth/chatgpt.ts";
import type { KeychainBackend } from "../../src/auth/types.ts";

const ISSUER = "https://auth.openai.com";
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: "jwk" }), kid: "k1", alg: "RS256", use: "sig" };

function idToken(claims: Record<string, unknown>): string {
  const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const head = `${part({ alg: "RS256", kid: "k1" })}.${part(claims)}`;
  return `${head}.${sign("RSA-SHA256", Buffer.from(head), privateKey).toString("base64url")}`;
}

function memoryKeychain(): KeychainBackend & { store: Map<string, string> } {
  const store = new Map<string, string>();
  return {
    name: "memory",
    isAvailable: async () => true,
    get: async (key) => store.get(key),
    set: async (key, value) => {
      store.set(key, value);
    },
    delete: async (key) => {
      store.delete(key);
    },
    store,
  };
}

/** The auth server of OpenAI as its docs describe it, and a browser that signs in at once. */
function fakeOpenAi(options: { scope?: string; refreshError?: { status: number; error: string } } = {}) {
  const authorizations: URLSearchParams[] = [];
  const tokenForms: URLSearchParams[] = [];
  const revoked: URLSearchParams[] = [];
  let nonce = "";
  let refreshes = 0;
  const scope =
    options.scope ?? "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct";
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url === `${ISSUER}/.well-known/openid-configuration`) {
      return Response.json({ jwks_uri: `${ISSUER}/jwks`, revocation_endpoint: `${ISSUER}/revoke` });
    }
    if (url === `${ISSUER}/jwks`) return Response.json({ keys: [jwk] });
    if (url === `${ISSUER}/revoke`) {
      revoked.push(new URLSearchParams(String(init?.body)));
      return new Response("", { status: 200 });
    }
    if (url === `${ISSUER}/api/accounts/oauth/token`) {
      const form = new URLSearchParams(String(init?.body));
      tokenForms.push(form);
      if (form.get("grant_type") === "refresh_token") {
        refreshes += 1;
        if (options.refreshError) {
          return Response.json(
            { error: options.refreshError.error },
            { status: options.refreshError.status },
          );
        }
        return Response.json({
          access_token: `access-${refreshes + 1}`,
          refresh_token: `refresh-${refreshes + 1}`,
          expires_in: 3600,
        });
      }
      return Response.json({
        access_token: "access-1",
        refresh_token: "refresh-1",
        expires_in: 3600,
        scope,
        id_token: idToken({
          iss: ISSUER,
          aud: "oaiapp_1",
          sub: "user-1",
          email: "me@example.com",
          nonce,
          exp: Date.now() / 1000 + 3600,
        }),
      });
    }
    if (url === "https://api.openai.com/v1/models") {
      return Response.json({
        data: [
          { slug: "gpt-5.5", display_name: "GPT-5.5", visibility: "list" },
          { slug: "internal", display_name: "Internal", visibility: "hide" },
        ],
      });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  const openUrl = async (address: string): Promise<void> => {
    const params = new URL(address).searchParams;
    authorizations.push(params);
    nonce = params.get("nonce") ?? "";
    const back = new URL(params.get("redirect_uri") ?? "");
    for (const [name, value] of Object.entries({
      code: "code-1",
      state: params.get("state") ?? "",
      client_id: "oaiapp_1",
      scope,
    })) {
      back.searchParams.set(name, value);
    }
    await fetch(back);
  };
  return { fetchFn, openUrl, authorizations, tokenForms, revoked, refreshes: () => refreshes };
}

describe("Sign in with ChatGPT", () => {
  test("the first sign-in registers Agency for the host; a later one reuses the issued client id", async () => {
    const keychain = memoryKeychain();
    const openai = fakeOpenAi();
    const credential = await signInChatgpt(keychain, { fetchFn: openai.fetchFn, openUrl: openai.openUrl });
    expect(credential).toMatchObject({
      subject: "user-1",
      email: "me@example.com",
      clientId: "oaiapp_1",
      accessToken: "access-1",
    });

    const first = openai.authorizations[0] ?? new URLSearchParams();
    expect(Object.fromEntries(first)).toMatchObject({
      client_id: "dynamic_agent_client",
      agent_name_hint: "Agency",
      response_type: "code",
      scope: "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct",
      resource: "https://api.openai.com/v1",
      code_challenge_method: "S256",
    });
    expect(first.get("ext_agent_host_id")).toMatch(/^urn:uuid:[0-9a-f-]{36}$/);
    expect(first.get("redirect_uri")).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/auth\/callback$/);
    expect(Object.fromEntries(openai.tokenForms[0] ?? [])).toMatchObject({
      grant_type: "authorization_code",
      client_id: "oaiapp_1",
      code: "code-1",
      resource: "https://api.openai.com/v1",
    });

    await signInChatgpt(keychain, { fetchFn: openai.fetchFn, openUrl: openai.openUrl });
    const again = openai.authorizations[1] ?? new URLSearchParams();
    expect(again.get("client_id")).toBe("oaiapp_1");
    expect(again.get("id_token_hint")).toBe(credential.idToken);
    expect(again.get("agent_name_hint")).toBeNull();
    expect(again.get("ext_agent_host_id")).toBe(first.get("ext_agent_host_id"));
  });

  test("a sign-in without plan usage is refused, and nothing is kept", async () => {
    const keychain = memoryKeychain();
    const openai = fakeOpenAi({ scope: "openid profile email offline_access" });
    await expect(
      signInChatgpt(keychain, { fetchFn: openai.fetchFn, openUrl: openai.openUrl }),
    ).rejects.toThrow("did not grant plan usage");
    expect(await getChatgptCredential(keychain)).toBeUndefined();
  });

  test("an old token is refreshed once for calls at the same time, with the rotated refresh token kept", async () => {
    const keychain = memoryKeychain();
    const openai = fakeOpenAi();
    await signInChatgpt(keychain, { fetchFn: openai.fetchFn, openUrl: openai.openUrl });
    const saved = (await getChatgptCredential(keychain))!;
    await keychain.set("chatgpt:oauth", JSON.stringify({ ...saved, expiresAt: Date.now() }));
    const tokens = await Promise.all([
      chatgptAccessToken(keychain, openai.fetchFn),
      chatgptAccessToken(keychain, openai.fetchFn),
    ]);
    expect(tokens).toEqual(["access-2", "access-2"]);
    expect(openai.refreshes()).toBe(1);
    expect(Object.fromEntries(openai.tokenForms.at(-1) ?? [])).toEqual({
      grant_type: "refresh_token",
      refresh_token: "refresh-1",
      resource: "https://api.openai.com/v1",
      client_id: "oaiapp_1",
    });
    expect((await getChatgptCredential(keychain))?.refreshToken).toBe("refresh-2");
    expect(await chatgptAccessToken(keychain, openai.fetchFn)).toBe("access-2");
  });

  test("a dead refresh token asks for a new sign-in; a server error keeps the credential", async () => {
    for (const [refreshError, code] of [
      [{ status: 400, error: "refresh_token_reused" }, ErrorCode.AUTH],
      [{ status: 503, error: "unavailable" }, ErrorCode.TRANSIENT],
    ] as const) {
      const keychain = memoryKeychain();
      const openai = fakeOpenAi({ refreshError });
      await signInChatgpt(keychain, { fetchFn: openai.fetchFn, openUrl: openai.openUrl });
      const saved = (await getChatgptCredential(keychain))!;
      await keychain.set("chatgpt:oauth", JSON.stringify({ ...saved, expiresAt: 0 }));
      const error = await chatgptAccessToken(keychain, openai.fetchFn).catch((e: unknown) => e);
      expect((error as AgencyError).code).toBe(code);
      expect(await getChatgptCredential(keychain)).toBeDefined();
    }
  });

  test("sign-out revokes the refresh token and keeps the host id; the model list keeps the listed models", async () => {
    const keychain = memoryKeychain();
    const openai = fakeOpenAi();
    await signInChatgpt(keychain, { fetchFn: openai.fetchFn, openUrl: openai.openUrl });
    expect(await listChatgptModels("access-1", openai.fetchFn)).toEqual([
      { slug: "gpt-5.5", name: "GPT-5.5" },
    ]);
    expect(await signOutChatgpt(keychain, openai.fetchFn)).toBe(true);
    expect(Object.fromEntries(openai.revoked[0] ?? [])).toEqual({
      token: "refresh-1",
      token_type_hint: "refresh_token",
      client_id: "oaiapp_1",
    });
    expect(await getChatgptCredential(keychain)).toBeUndefined();
    expect(keychain.store.get("chatgpt:host")).toMatch(/^urn:uuid:/);
  });

  test("an ID token with another audience or a changed signature is refused", async () => {
    const { fetchFn } = fakeOpenAi();
    const claims = { iss: ISSUER, aud: "oaiapp_1", sub: "u", exp: Date.now() / 1000 + 60 };
    expect(await verifyIdToken(idToken(claims), "oaiapp_1", undefined, fetchFn)).toMatchObject({ sub: "u" });
    await expect(verifyIdToken(idToken(claims), "oaiapp_2", undefined, fetchFn)).rejects.toThrow("audience");
    const [head, , signature] = idToken(claims).split(".");
    const forged = `${head}.${Buffer.from(JSON.stringify({ ...claims, sub: "other" })).toString("base64url")}.${signature}`;
    await expect(verifyIdToken(forged, "oaiapp_1", undefined, fetchFn)).rejects.toThrow("signature");
  });
});
