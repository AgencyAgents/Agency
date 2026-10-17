import { createPublicKey, type JsonWebKeyInput, randomBytes, randomUUID, verify } from "node:crypto";
import { AgencyError, ErrorCode } from "@agency/schema";
import { generatePkcePair, oauthKey, openInBrowser, startCallbackServer } from "./oauth.ts";
import type { KeychainBackend } from "./types.ts";

/**
 * Sign in with ChatGPT for an open-source, locally hosted app, as OpenAI documents it at
 * developers.openai.com/siwc: dynamic client registration, PKCE on a loopback, and the plan scope.
 */
export const CHATGPT_PROVIDER = "chatgpt";
export const CHATGPT_RESOURCE = "https://api.openai.com/v1";
const ISSUER = "https://auth.openai.com";
const AUTHORIZE_URL = `${ISSUER}/api/accounts/authorize`;
const TOKEN_URL = `${ISSUER}/api/accounts/oauth/token`;
const PLAN_SCOPE = "chatgpt.tokens.use.direct";
const SCOPE = `openid profile email offline_access resource.invoke ${PLAN_SCOPE}`;
const RECORD_KEY = oauthKey(CHATGPT_PROVIDER);
const HOST_KEY = `${CHATGPT_PROVIDER}:host`;
/** OpenAI names these as a refresh token that will not work again: only a new sign-in helps. */
const DEAD_REFRESH = new Set([
  "invalid_grant",
  "invalid_refresh_token",
  "token_expired",
  "refresh_token_expired",
  "refresh_token_invalidated",
  "refresh_token_reused",
]);

export interface ChatgptCredential {
  issuer: string;
  /** The account, from the checked ID token. */
  subject: string;
  email?: string;
  /** Issued at the first sign-in of this account on this host, and kept for each later one. */
  clientId: string;
  hostId: string;
  idToken: string;
  accessToken: string;
  refreshToken: string;
  /** Epoch ms. */
  expiresAt: number;
  scopes: string[];
}

const b64url = (bytes: Buffer): string => bytes.toString("base64url");

export async function getChatgptCredential(
  keychain: KeychainBackend,
): Promise<ChatgptCredential | undefined> {
  const raw = await keychain.get(RECORD_KEY);
  try {
    return raw ? (JSON.parse(raw) as ChatgptCredential) : undefined;
  } catch {
    return undefined;
  }
}

/** One stable, opaque id for this host: OpenAI binds the registration to it. */
async function hostIdOf(keychain: KeychainBackend): Promise<string> {
  const saved = await keychain.get(HOST_KEY);
  if (saved) return saved;
  const id = `urn:uuid:${randomUUID()}`;
  await keychain.set(HOST_KEY, id);
  return id;
}

async function jsonAt<T>(url: string, fetchFn: typeof fetch): Promise<T> {
  const res = await fetchFn(url, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  return (await res.json()) as T;
}

/** The claims of an ID token whose signature, issuer, audience, expiry and nonce hold. */
export async function verifyIdToken(
  idToken: string,
  clientId: string,
  nonce: string | undefined,
  fetchFn: typeof fetch = fetch,
): Promise<Record<string, unknown>> {
  const [head = "", body = "", signature = ""] = idToken.split(".");
  const header = JSON.parse(Buffer.from(head, "base64url").toString("utf8")) as {
    alg?: string;
    kid?: string;
  };
  const claims = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as Record<string, unknown>;
  const fail = (why: string): never => {
    throw new AgencyError(ErrorCode.AUTH, `the ID token of ChatGPT is not valid: ${why}`, {
      source: "chatgpt",
    });
  };
  if (header.alg !== "RS256") fail(`algorithm ${header.alg}`);
  const config = await jsonAt<{ jwks_uri: string }>(`${ISSUER}/.well-known/openid-configuration`, fetchFn);
  const { keys } = await jsonAt<{ keys: Array<JsonWebKeyInput["key"] & { kid?: string }> }>(
    config.jwks_uri,
    fetchFn,
  );
  const jwk = keys.find((k) => k.kid === header.kid) ?? fail("no key of its id");
  const key = createPublicKey({ key: jwk, format: "jwk" });
  if (!verify("RSA-SHA256", Buffer.from(`${head}.${body}`), key, Buffer.from(signature, "base64url"))) {
    fail("signature");
  }
  if (claims.iss !== ISSUER) fail(`issuer ${String(claims.iss)}`);
  const audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!audience.includes(clientId)) fail("audience");
  if (typeof claims.exp !== "number" || claims.exp * 1000 <= Date.now()) fail("expired");
  if (nonce !== undefined && claims.nonce !== nonce) fail("nonce");
  if (typeof claims.sub !== "string") fail("no subject");
  return claims;
}

async function tokenRequest(form: Record<string, string>, fetchFn: typeof fetch) {
  const res = await fetchFn(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams(form),
  });
  const body = (await res.json().catch(() => ({}))) as {
    access_token?: string;
    refresh_token?: string;
    id_token?: string;
    expires_in?: number;
    scope?: string;
    error?: string | { code?: string };
  };
  return { res, body, error: typeof body.error === "string" ? body.error : body.error?.code };
}

/**
 * Signs in with the browser and keeps the credential in the keychain. A host with a saved sign-in reuses its
 * issued client id; the first sign-in registers Agency for this account and host.
 */
export async function signInChatgpt(
  keychain: KeychainBackend,
  options: {
    openUrl?: (url: string) => Promise<void> | void;
    fetchFn?: typeof fetch;
    timeoutMs?: number;
  } = {},
): Promise<ChatgptCredential> {
  const fetchFn = options.fetchFn ?? fetch;
  const saved = await getChatgptCredential(keychain);
  const hostId = await hostIdOf(keychain);
  const state = b64url(randomBytes(16));
  const nonce = b64url(randomBytes(16));
  const { verifier, challenge } = generatePkcePair();
  const callback = await startCallbackServer({
    expectedState: state,
    timeoutMs: options.timeoutMs ?? 300_000,
  });
  try {
    const redirectUri = `http://127.0.0.1:${callback.port}/auth/callback`;
    const url = new URL(AUTHORIZE_URL);
    for (const [name, value] of Object.entries({
      client_id: saved?.clientId ?? "dynamic_agent_client",
      ...(saved
        ? { id_token_hint: saved.idToken, ...(saved.email ? { login_hint: saved.email } : {}) }
        : { agent_name_hint: "Agency" }),
      ext_agent_host_id: hostId,
      response_type: "code",
      redirect_uri: redirectUri,
      scope: SCOPE,
      resource: CHATGPT_RESOURCE,
      state,
      nonce,
      code_challenge: challenge,
      code_challenge_method: "S256",
    })) {
      url.searchParams.set(name, value);
    }
    await (options.openUrl ?? openInBrowser)(url.toString());
    const { code, params } = await callback.waitForCallback;
    const issued = params.client_id;
    if (!saved && !issued)
      throw new Error("ChatGPT gave no client id: the registration is not complete. Sign in again.");
    if (saved && issued && issued !== saved.clientId) {
      throw new Error("ChatGPT gave another client id for this sign-in: the sign-in was refused.");
    }
    const clientId = saved?.clientId ?? issued ?? "";
    const { res, body, error } = await tokenRequest(
      {
        grant_type: "authorization_code",
        client_id: clientId,
        code,
        code_verifier: verifier,
        redirect_uri: redirectUri,
        resource: CHATGPT_RESOURCE,
      },
      fetchFn,
    );
    if (!res.ok || !body.access_token || !body.refresh_token || !body.id_token) {
      throw new Error(`ChatGPT sign-in failed: ${res.status} ${error ?? "no tokens"}`);
    }
    const scopes = (body.scope ?? params.scope ?? "").split(" ").filter(Boolean);
    if (!scopes.includes(PLAN_SCOPE)) {
      throw new Error(
        "ChatGPT did not grant plan usage to Agency. Sign in again and allow it, or use an OpenAI API key.",
      );
    }
    const claims = await verifyIdToken(body.id_token, clientId, nonce, fetchFn);
    if (saved && claims.sub !== saved.subject) {
      throw new Error("This sign-in is for another ChatGPT account. Run `agency auth logout chatgpt` first.");
    }
    const credential: ChatgptCredential = {
      issuer: ISSUER,
      subject: String(claims.sub),
      ...(typeof claims.email === "string" ? { email: claims.email } : {}),
      clientId,
      hostId,
      idToken: body.id_token,
      accessToken: body.access_token,
      refreshToken: body.refresh_token,
      expiresAt: Date.now() + (body.expires_in ?? 3600) * 1000,
      scopes,
    };
    await keychain.set(RECORD_KEY, JSON.stringify(credential));
    return credential;
  } finally {
    callback.close();
  }
}

let refreshing: Promise<string> | undefined;

/**
 * The access token of the saved sign-in, refreshed a minute before it ends. One refresh at a time: OpenAI rotates
 * the refresh token, so a second refresh with the old one would fail.
 */
export async function chatgptAccessToken(
  keychain: KeychainBackend,
  fetchFn: typeof fetch = fetch,
): Promise<string | undefined> {
  const credential = await getChatgptCredential(keychain);
  if (!credential) return undefined;
  if (credential.expiresAt - 60_000 > Date.now()) return credential.accessToken;
  refreshing ??= refresh(keychain, credential, fetchFn).finally(() => {
    refreshing = undefined;
  });
  return refreshing;
}

async function refresh(
  keychain: KeychainBackend,
  credential: ChatgptCredential,
  fetchFn: typeof fetch,
): Promise<string> {
  let result: Awaited<ReturnType<typeof tokenRequest>>;
  try {
    result = await tokenRequest(
      {
        grant_type: "refresh_token",
        refresh_token: credential.refreshToken,
        resource: CHATGPT_RESOURCE,
        client_id: credential.clientId,
      },
      fetchFn,
    );
  } catch (error) {
    // A network failure keeps the credential: it is not proof that the sign-in ended.
    throw new AgencyError(ErrorCode.NETWORK, `ChatGPT token refresh failed: ${String(error)}`, {
      source: "chatgpt",
    });
  }
  const { res, body, error } = result;
  if (!res.ok || !body.access_token) {
    if (error && DEAD_REFRESH.has(error)) {
      throw new AgencyError(ErrorCode.AUTH, "The ChatGPT sign-in ended. Run `agency auth login chatgpt`.", {
        source: "chatgpt",
      });
    }
    throw new AgencyError(
      ErrorCode.TRANSIENT,
      `ChatGPT token refresh failed: ${res.status} ${error ?? ""}`.trim(),
      {
        source: "chatgpt",
      },
    );
  }
  const next: ChatgptCredential = {
    ...credential,
    accessToken: body.access_token,
    refreshToken: body.refresh_token ?? credential.refreshToken,
    expiresAt: Date.now() + (body.expires_in ?? 3600) * 1000,
    ...(body.scope ? { scopes: body.scope.split(" ").filter(Boolean) } : {}),
    ...(body.id_token ? { idToken: body.id_token } : {}),
  };
  await keychain.set(RECORD_KEY, JSON.stringify(next));
  return next.accessToken;
}

/** Revokes the refresh token and removes the sign-in. False: the revocation was not confirmed. */
export async function signOutChatgpt(
  keychain: KeychainBackend,
  fetchFn: typeof fetch = fetch,
): Promise<boolean> {
  const credential = await getChatgptCredential(keychain);
  if (!credential) return true;
  let revoked = false;
  try {
    const config = await jsonAt<{ revocation_endpoint?: string }>(
      `${ISSUER}/.well-known/openid-configuration`,
      fetchFn,
    );
    if (config.revocation_endpoint) {
      const res = await fetchFn(config.revocation_endpoint, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          token: credential.refreshToken,
          token_type_hint: "refresh_token",
          client_id: credential.clientId,
        }),
      });
      revoked = res.ok;
    }
  } catch {}
  await keychain.delete(RECORD_KEY);
  return revoked;
}

/** The models of the signed-in plan, in the order of the server: the slug to use and the name to show. */
export async function listChatgptModels(
  accessToken: string,
  fetchFn: typeof fetch = fetch,
): Promise<Array<{ slug: string; name: string }>> {
  const res = await fetchFn(`${CHATGPT_RESOURCE}/models`, {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) return [];
  const body = (await res.json()) as { data?: unknown[]; models?: unknown[] };
  return (body.data ?? body.models ?? []).flatMap((entry) => {
    const m = entry as { slug?: string; id?: string; display_name?: string; visibility?: string };
    const slug = m.slug ?? m.id;
    return m.visibility === "list" && slug ? [{ slug, name: m.display_name ?? slug }] : [];
  });
}
