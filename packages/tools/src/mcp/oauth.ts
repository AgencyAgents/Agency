import { createHash, randomBytes } from "node:crypto";
import {
  generatePkcePair,
  type KeychainBackend,
  openInBrowser,
  startCallbackServer,
} from "@agency/providers";

/** The sign-in to one MCP server: the tokens, and what a refresh needs. */
export interface McpSignIn {
  accessToken: string;
  refreshToken?: string;
  /** Epoch ms. Undefined: the server gave no lifetime. */
  expiresAt?: number;
  clientId: string;
  clientSecret?: string;
  tokenEndpoint: string;
  /** RFC 8707: the server that the token is for. */
  resource: string;
}

/** Sign-ins by the URL of the server. */
export interface McpTokenStore {
  get(url: string): Promise<McpSignIn | undefined>;
  set(url: string, signIn: McpSignIn): Promise<void>;
  delete(url: string): Promise<void>;
}

/** In the OS keychain. The account name is a hash: the Windows store makes a file name of it. */
export function keychainTokenStore(keychain: () => Promise<KeychainBackend>): McpTokenStore {
  const account = (url: string): string =>
    `mcp-oauth-${createHash("sha256").update(url).digest("hex").slice(0, 32)}`;
  return {
    async get(url) {
      const raw = await (await keychain()).get(account(url));
      try {
        return raw ? (JSON.parse(raw) as McpSignIn) : undefined;
      } catch {
        return undefined;
      }
    },
    set: async (url, signIn) => (await keychain()).set(account(url), JSON.stringify(signIn)),
    delete: async (url) => (await keychain()).delete(account(url)),
  };
}

interface AuthServerMetadata {
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint?: string;
}

async function jsonAt<T>(url: string, fetchFn: typeof fetch): Promise<T | undefined> {
  try {
    const res = await fetchFn(url, { headers: { accept: "application/json" } });
    return res.ok ? ((await res.json()) as T) : undefined;
  } catch {
    return undefined;
  }
}

/** RFC 8414 puts the well-known part before the path of the issuer; OpenID Connect puts it after. */
async function authServerMetadata(issuer: string, fetchFn: typeof fetch): Promise<AuthServerMetadata> {
  const { origin, pathname } = new URL(issuer);
  const path = pathname.replace(/\/$/, "");
  for (const url of [
    `${origin}/.well-known/oauth-authorization-server${path}`,
    `${origin}/.well-known/openid-configuration${path}`,
    `${origin}${path}/.well-known/openid-configuration`,
  ]) {
    const meta = await jsonAt<AuthServerMetadata>(url, fetchFn);
    if (meta?.authorization_endpoint && meta.token_endpoint) return meta;
  }
  // A server of the 2025-03-26 spec with no metadata: the default paths of that spec.
  return {
    authorization_endpoint: `${origin}/authorize`,
    token_endpoint: `${origin}/token`,
    registration_endpoint: `${origin}/register`,
  };
}

/**
 * RFC 9728: the 401 of the server names its resource metadata, or it is at the well-known path. A server with
 * none is its own authorization server.
 */
async function discover(
  url: string,
  fetchFn: typeof fetch,
): Promise<{ resource: string; server: AuthServerMetadata; scope?: string }> {
  const probe = await fetchFn(url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 0, method: "ping" }),
  }).catch(() => undefined);
  const challenge = probe?.headers.get("www-authenticate") ?? "";
  const named = /resource_metadata="([^"]+)"/.exec(challenge)?.[1];
  const { origin, pathname } = new URL(url);
  const candidates = named
    ? [named]
    : [
        `${origin}/.well-known/oauth-protected-resource${pathname.replace(/\/$/, "")}`,
        `${origin}/.well-known/oauth-protected-resource`,
      ];
  let resourceMeta:
    | { resource?: string; authorization_servers?: string[]; scopes_supported?: string[] }
    | undefined;
  for (const candidate of candidates) {
    resourceMeta = await jsonAt(candidate, fetchFn);
    if (resourceMeta) break;
  }
  const server = await authServerMetadata(resourceMeta?.authorization_servers?.[0] ?? origin, fetchFn);
  const scope = /scope="([^"]+)"/.exec(challenge)?.[1] ?? resourceMeta?.scopes_supported?.join(" ");
  return { resource: resourceMeta?.resource ?? url, server, ...(scope ? { scope } : {}) };
}

async function tokenRequest(
  params: Record<string, string>,
  client: { clientId: string; clientSecret?: string; tokenEndpoint: string; resource: string },
  fetchFn: typeof fetch,
): Promise<McpSignIn> {
  const body = new URLSearchParams({
    ...params,
    client_id: client.clientId,
    resource: client.resource,
    ...(client.clientSecret ? { client_secret: client.clientSecret } : {}),
  });
  const res = await fetchFn(client.tokenEndpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body,
  });
  if (!res.ok) throw new Error(`token request failed: ${res.status} ${(await res.text()).slice(0, 300)}`);
  const token = (await res.json()) as { access_token: string; refresh_token?: string; expires_in?: number };
  return {
    clientId: client.clientId,
    ...(client.clientSecret ? { clientSecret: client.clientSecret } : {}),
    tokenEndpoint: client.tokenEndpoint,
    resource: client.resource,
    accessToken: token.access_token,
    ...(token.refresh_token ? { refreshToken: token.refresh_token } : {}),
    ...(token.expires_in ? { expiresAt: Date.now() + token.expires_in * 1000 } : {}),
  };
}

/**
 * The sign-in of the MCP authorization spec: discovery, dynamic client registration, the authorization code with
 * PKCE in the browser, and the code for tokens at a loopback callback.
 */
export async function signInMcpServer(
  url: string,
  store: McpTokenStore,
  options: {
    openUrl?: (url: string) => Promise<void> | void;
    fetchFn?: typeof fetch;
    timeoutMs?: number;
  } = {},
): Promise<McpSignIn> {
  const fetchFn = options.fetchFn ?? fetch;
  const { resource, server, scope } = await discover(url, fetchFn);
  if (!server.registration_endpoint) {
    throw new Error(
      `the authorization server of ${url} takes no client registration; Agency has no client id for it`,
    );
  }
  const state = randomBytes(16).toString("base64url");
  const callback = await startCallbackServer({
    expectedState: state,
    timeoutMs: options.timeoutMs ?? 300_000,
  });
  try {
    const redirectUri = `http://127.0.0.1:${callback.port}/callback`;
    const registered = await fetchFn(server.registration_endpoint, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({
        client_name: "Agency",
        redirect_uris: [redirectUri],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      }),
    });
    if (!registered.ok) {
      throw new Error(
        `client registration failed: ${registered.status} ${(await registered.text()).slice(0, 300)}`,
      );
    }
    const client = (await registered.json()) as { client_id: string; client_secret?: string };
    const { verifier, challenge } = generatePkcePair();
    const authorize = new URL(server.authorization_endpoint);
    for (const [key, value] of Object.entries({
      response_type: "code",
      client_id: client.client_id,
      redirect_uri: redirectUri,
      state,
      code_challenge: challenge,
      code_challenge_method: "S256",
      resource,
      ...(scope ? { scope } : {}),
    })) {
      authorize.searchParams.set(key, value);
    }
    await (options.openUrl ?? openInBrowser)(authorize.toString());
    const { code } = await callback.waitForCallback;
    const signIn = await tokenRequest(
      { grant_type: "authorization_code", code, redirect_uri: redirectUri, code_verifier: verifier },
      {
        clientId: client.client_id,
        ...(client.client_secret ? { clientSecret: client.client_secret } : {}),
        tokenEndpoint: server.token_endpoint,
        resource,
      },
      fetchFn,
    );
    await store.set(url, signIn);
    return signIn;
  } finally {
    callback.close();
  }
}

/** The bearer token of a server: none without a sign-in, a refreshed one a minute before it ends. */
export interface McpBearer {
  token(): Promise<string | undefined>;
  /** A new token after the server refused the last one; undefined when there is none. */
  refresh(): Promise<string | undefined>;
}

export function mcpBearer(url: string, store: McpTokenStore, fetchFn: typeof fetch = fetch): McpBearer {
  let current: McpSignIn | undefined;
  let loading: Promise<void> | undefined;
  // The notification stream and the first request ask at the same time: one refresh serves both.
  let refreshing: Promise<string | undefined> | undefined;
  const load = (): Promise<void> => {
    loading ??= store.get(url).then((signIn) => {
      current = signIn;
    });
    return loading;
  };
  const renew = async (): Promise<string | undefined> => {
    await load();
    const signIn = current;
    if (!signIn?.refreshToken) return undefined;
    try {
      const next = await tokenRequest(
        { grant_type: "refresh_token", refresh_token: signIn.refreshToken },
        signIn,
        fetchFn,
      );
      // A server that does not rotate the refresh token keeps the old one valid.
      current = { refreshToken: signIn.refreshToken, ...next };
      await store.set(url, current);
      return current.accessToken;
    } catch {
      return undefined;
    }
  };
  const refresh = (): Promise<string | undefined> => {
    refreshing ??= renew().finally(() => {
      refreshing = undefined;
    });
    return refreshing;
  };
  return {
    async token() {
      await load();
      if (!current) return undefined;
      if (current.expiresAt !== undefined && current.expiresAt - 60_000 < Date.now()) return refresh();
      return current.accessToken;
    },
    refresh,
  };
}
