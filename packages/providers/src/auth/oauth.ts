import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { AgencyError, ErrorCode } from "@agency/schema";
import type { KeychainBackend } from "./types.ts";

export interface OAuthToken {
  type: "oauth";
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
}

export interface OAuthProviderConfig {
  authorizeUrl: string;
  tokenUrl: string;
  clientId: string;
  scopes: string[];
  redirectPath?: string;
  /** RFC 8628 device authorization endpoint. Presence opts the provider in. */
  deviceAuthorizationUrl?: string;
  /** Optional base URL override. When set, authorizeUrl and tokenUrl are derived from it
   *  by appending /authorize and /token respectively. Useful for self-hosted gateways
   *  or OpenAI-compatible endpoints with custom OAuth paths. */
  baseUrl?: string;
}

export const OAUTH_PROVIDERS: Record<string, OAuthProviderConfig> = {
  anthropic: {
    authorizeUrl: "https://console.anthropic.com/oauth/authorize",
    tokenUrl: "https://console.anthropic.com/oauth/token",
    clientId: "agency-anthropic-oauth",
    scopes: ["user:inference"],
  },
  openai: {
    authorizeUrl: "https://auth.openai.com/authorize",
    tokenUrl: "https://auth.openai.com/api/oauth/token",
    clientId: "agency-openai-oauth",
    scopes: ["openai.api.request"],
  },
  google: {
    authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    clientId: "agency-google-oauth",
    scopes: ["https://www.googleapis.com/auth/generative-language.retrieve"],
  },
  "github-copilot": {
    authorizeUrl: "https://github.com/login/oauth/authorize",
    tokenUrl: "https://github.com/login/oauth/access_token",
    deviceAuthorizationUrl: "https://github.com/login/device/code",
    clientId: "agency-copilot-oauth",
    scopes: ["copilot"],
  },
};

/** Known placeholder clientId values that ship as defaults and must be replaced. */
const PLACEHOLDER_CLIENT_IDS = new Set([
  "agency-anthropic-oauth",
  "agency-openai-oauth",
  "agency-google-oauth",
  "agency-copilot-oauth",
]);

/**
 * Resolves the effective OAuth config, applying the baseUrl override if set.
 * When baseUrl is provided, authorizeUrl and tokenUrl are derived from it
 * by appending /authorize and /token respectively, allowing custom endpoints
 * per connect-provider (e.g. self-hosted gateways).
 */
export function resolveOAuthConfig(config: OAuthProviderConfig): OAuthProviderConfig {
  if (!config.baseUrl) return config;
  const base = config.baseUrl.replace(/\/+$/, "");
  return {
    ...config,
    authorizeUrl: `${base}/authorize`,
    tokenUrl: `${base}/token`,
  };
}

export interface ProviderOAuthOverrides {
  clientId?: string;
  baseUrl?: string;
}

export function resolveProviderOAuthConfig(
  provider: string,
  overrides?: ProviderOAuthOverrides,
): OAuthProviderConfig {
  const base = OAUTH_PROVIDERS[provider];
  if (!base) throw new Error(`Unknown OAuth provider: ${provider}`);
  const merged: OAuthProviderConfig = {
    ...base,
    ...(overrides?.clientId ? { clientId: overrides.clientId } : {}),
    ...(overrides?.baseUrl ? { baseUrl: overrides.baseUrl } : {}),
  };
  return resolveOAuthConfig(merged);
}

function assertClientIdConfigured(config: OAuthProviderConfig, provider: string): void {
  if (!config.clientId || PLACEHOLDER_CLIENT_IDS.has(config.clientId)) {
    throw new AgencyError(
      ErrorCode.AUTH,
      `OAuth not configured for provider "${provider}": register an OAuth app at the provider's developer console and set provider.${provider}.oauth.clientId in your config`,
      { source: "oauth" },
    );
  }
}

function base64UrlEncode(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export function generatePkcePair(): { verifier: string; challenge: string } {
  const verifier = base64UrlEncode(randomBytes(32));
  const challenge = base64UrlEncode(createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

export function buildAuthorizeUrl(
  config: OAuthProviderConfig,
  options: { redirectUri: string; state: string; challenge: string },
): string {
  const resolved = resolveOAuthConfig(config);
  const url = new URL(resolved.authorizeUrl);
  url.searchParams.set("client_id", resolved.clientId);
  url.searchParams.set("redirect_uri", options.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", resolved.scopes.join(" "));
  url.searchParams.set("state", options.state);
  url.searchParams.set("code_challenge", options.challenge);
  url.searchParams.set("code_challenge_method", "S256");
  return url.toString();
}

export function isOAuthToken(value: string | undefined): boolean {
  if (!value) return false;
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    return parsed.type === "oauth" && typeof parsed.accessToken === "string";
  } catch {
    return false;
  }
}

export function parseOAuthToken(value: string): OAuthToken | undefined {
  try {
    const parsed = JSON.parse(value) as OAuthToken;
    if (parsed.type === "oauth" && typeof parsed.accessToken === "string") return parsed;
  } catch {}
  return undefined;
}

export function oauthKey(provider: string): string {
  return `${provider}:oauth`;
}

function tokenKey(provider: string): string {
  return oauthKey(provider);
}

export async function storeOAuthToken(
  keychain: KeychainBackend,
  provider: string,
  token: OAuthToken,
): Promise<void> {
  await keychain.set(tokenKey(provider), JSON.stringify(token));
}

export async function getOAuthToken(
  keychain: KeychainBackend,
  provider: string,
): Promise<OAuthToken | undefined> {
  const raw = await keychain.get(tokenKey(provider));
  if (!raw) return undefined;
  return parseOAuthToken(raw);
}

const refreshInflight = new Map<string, Promise<string | undefined>>();

export async function refreshOAuthToken(
  keychain: KeychainBackend,
  provider: string,
  httpFetch: typeof fetch = fetch,
  overrides?: ProviderOAuthOverrides,
): Promise<string | undefined> {
  const existing = refreshInflight.get(provider);
  if (existing) return existing;

  const promise = (async (): Promise<string | undefined> => {
    const token = await getOAuthToken(keychain, provider);
    if (!token) return undefined;
    if (Date.now() < token.expiresAt - 60_000) return token.accessToken;
    if (!OAUTH_PROVIDERS[provider]) return token.accessToken;
    const resolved = resolveProviderOAuthConfig(provider, overrides);
    assertClientIdConfigured(resolved, provider);

    let res: Response;
    try {
      res = await httpFetch(resolved.tokenUrl, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({
          grant_type: "refresh_token",
          client_id: resolved.clientId,
          refresh_token: token.refreshToken,
        }),
      });
    } catch (error) {
      throw new AgencyError(
        ErrorCode.AUTH,
        `OAuth refresh for provider "${provider}" failed: ${error instanceof Error ? error.message : String(error)}. Run \`agency auth login ${provider} --oauth\` to reconnect.`,
        { source: "oauth" },
      );
    }
    if (!res.ok) {
      const detail = await res.text().catch(() => res.statusText);
      throw new AgencyError(
        ErrorCode.AUTH,
        `OAuth refresh for provider "${provider}" failed: ${res.status} ${detail}. Run \`agency auth login ${provider} --oauth\` to reconnect.`,
        { source: "oauth" },
      );
    }
    const body = (await res.json()) as {
      access_token?: string;
      refresh_token?: string;
      expires_in?: number;
    };
    if (!body.access_token) {
      throw new AgencyError(
        ErrorCode.AUTH,
        `OAuth refresh for provider "${provider}" returned no access token. Run \`agency auth login ${provider} --oauth\` to reconnect.`,
        { source: "oauth" },
      );
    }
    const next: OAuthToken = {
      type: "oauth",
      accessToken: body.access_token,
      refreshToken: body.refresh_token ?? token.refreshToken,
      expiresAt: Date.now() + (body.expires_in ?? 3600) * 1000,
    };
    await storeOAuthToken(keychain, provider, next);
    return next.accessToken;
  })();

  refreshInflight.set(provider, promise);
  try {
    return await promise;
  } finally {
    refreshInflight.delete(provider);
  }
}

export function clearRefreshInflight(): void {
  refreshInflight.clear();
}

export interface CallbackResult {
  code: string;
  state: string;
}

export function startCallbackServer(options: {
  expectedState: string;
  timeoutMs?: number;
}): Promise<{ port: number; waitForCallback: Promise<CallbackResult>; close: () => void }> {
  const timeoutMs = options.timeoutMs ?? 120_000;
  let resolveCb: (v: CallbackResult) => void;
  let rejectCb: (e: Error) => void;
  const waitForCallback = new Promise<CallbackResult>((resolve, reject) => {
    resolveCb = resolve;
    rejectCb = reject;
  });

  const srv = createServer((req, res) => {
    const url = new URL(req.url ?? "/", `http://localhost`);
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    const error = url.searchParams.get("error");
    if (error) {
      res.writeHead(400, { "content-type": "text/plain" });
      res.end(`OAuth error: ${error}`);
      rejectCb(new Error(`OAuth error: ${error}`));
      return;
    }
    if (!code || !state) {
      res.writeHead(400, { "content-type": "text/plain" });
      res.end("Missing code or state");
      return;
    }
    if (state !== options.expectedState) {
      res.writeHead(400, { "content-type": "text/plain" });
      res.end("Invalid state");
      rejectCb(new Error("Invalid OAuth state"));
      return;
    }
    res.writeHead(200, { "content-type": "text/html" });
    res.end("<html><body><h1>Authorized — you can close this tab.</h1></body></html>");
    resolveCb({ code, state });
  });

  return new Promise((resolve, reject) => {
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address() as { port: number } | null;
      if (!addr) {
        reject(new Error("Failed to bind callback server"));
        return;
      }
      const timer = setTimeout(() => {
        rejectCb(new Error("OAuth callback timed out"));
        srv.close();
      }, timeoutMs);
      timer.unref?.();
      waitForCallback
        .finally(() => clearTimeout(timer))
        .catch(() => {
          /* best-effort cleanup: server may already be closed */
        });
      resolve({
        port: addr.port,
        waitForCallback,
        close: () => srv.close(),
      });
    });
    srv.on("error", reject);
  });
}

export async function exchangeCodeForToken(
  provider: string,
  code: string,
  verifier: string,
  redirectUri: string,
  httpFetch: typeof fetch = fetch,
  overrides?: ProviderOAuthOverrides,
): Promise<OAuthToken> {
  const resolved = resolveProviderOAuthConfig(provider, overrides);
  assertClientIdConfigured(resolved, provider);
  const res = await httpFetch(resolved.tokenUrl, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({
      grant_type: "authorization_code",
      client_id: resolved.clientId,
      code,
      redirect_uri: redirectUri,
      code_verifier: verifier,
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    throw new Error(`Token exchange failed: ${res.status} ${text}`);
  }
  const body = (await res.json()) as {
    access_token: string;
    refresh_token?: string;
    expires_in?: number;
  };
  return {
    type: "oauth",
    accessToken: body.access_token,
    refreshToken: body.refresh_token ?? "",
    expiresAt: Date.now() + (body.expires_in ?? 3600) * 1000,
  };
}

export async function runOAuthFlow(
  provider: string,
  keychain: KeychainBackend,
  options: {
    openUrl?: (url: string) => void | Promise<void>;
    httpFetch?: typeof fetch;
    clientId?: string;
    baseUrl?: string;
  } = {},
): Promise<OAuthToken> {
  const resolved = resolveProviderOAuthConfig(provider, {
    clientId: options.clientId,
    baseUrl: options.baseUrl,
  });
  assertClientIdConfigured(resolved, provider);
  const { verifier, challenge } = generatePkcePair();
  const state = base64UrlEncode(randomBytes(16));
  const { port, waitForCallback, close } = await startCallbackServer({ expectedState: state });
  const redirectUri = `http://127.0.0.1:${port}${resolved.redirectPath ?? "/callback"}`;
  const authorizeUrl = buildAuthorizeUrl(resolved, { redirectUri, state, challenge });
  try {
    if (options.openUrl) await options.openUrl(authorizeUrl);
    else {
      const { exec } = await import("node:child_process");
      const cmd =
        process.platform === "win32"
          ? `start "" "${authorizeUrl}"`
          : process.platform === "darwin"
            ? `open "${authorizeUrl}"`
            : `xdg-open "${authorizeUrl}"`;
      exec(cmd);
    }
    const { code } = await waitForCallback;
    const token = await exchangeCodeForToken(provider, code, verifier, redirectUri, options.httpFetch, {
      clientId: options.clientId,
      baseUrl: options.baseUrl,
    });
    await storeOAuthToken(keychain, provider, token);
    return token;
  } finally {
    close();
  }
}

export interface DeviceAuthorization {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete?: string;
  expiresIn: number;
  interval: number;
}

export interface DeviceFlowCallbacks {
  clientId?: string;
  baseUrl?: string;
  httpFetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  onUserCode?: (info: { userCode: string; verificationUri: string }) => void;
}

// Device flow opt-in: a provider participates only when configured.
export function supportsDeviceFlow(provider: string, overrides?: ProviderOAuthOverrides): boolean {
  const base = OAUTH_PROVIDERS[provider];
  if (!base) return false;
  return resolveProviderOAuthConfig(provider, overrides).deviceAuthorizationUrl !== undefined;
}

const DEFAULT_DEVICE_INTERVAL_S = 5;
const SLOW_DOWN_BACKOFF_S = 5;

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Starts the RFC 8628 device authorization on the provider endpoint.
export async function requestDeviceAuthorization(
  provider: string,
  httpFetch: typeof fetch = fetch,
  overrides?: ProviderOAuthOverrides,
): Promise<DeviceAuthorization> {
  const resolved = resolveProviderOAuthConfig(provider, overrides);
  assertClientIdConfigured(resolved, provider);
  if (!resolved.deviceAuthorizationUrl) {
    throw new AgencyError(ErrorCode.AUTH, `Device flow not supported for provider "${provider}"`, {
      source: "oauth",
    });
  }
  const res = await httpFetch(resolved.deviceAuthorizationUrl, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ client_id: resolved.clientId, scope: resolved.scopes.join(" ") }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    throw new AgencyError(ErrorCode.AUTH, `Device authorization failed: ${res.status} ${text}`, {
      source: "oauth",
    });
  }
  const body = (await res.json()) as {
    device_code?: string;
    user_code?: string;
    verification_uri?: string;
    verification_uri_complete?: string;
    expires_in?: number;
    interval?: number;
  };
  if (!body.device_code || !body.user_code || !body.verification_uri) {
    throw new AgencyError(ErrorCode.AUTH, "Device authorization returned an incomplete response", {
      source: "oauth",
    });
  }
  return {
    deviceCode: body.device_code,
    userCode: body.user_code,
    verificationUri: body.verification_uri,
    verificationUriComplete: body.verification_uri_complete,
    expiresIn: body.expires_in ?? 1800,
    interval: body.interval ?? DEFAULT_DEVICE_INTERVAL_S,
  };
}

// Polls the token endpoint until approval, denial, or expiry.
export async function pollDeviceToken(
  provider: string,
  device: DeviceAuthorization,
  httpFetch: typeof fetch = fetch,
  options: { clientId?: string; baseUrl?: string; sleep?: (ms: number) => Promise<void> } = {},
): Promise<OAuthToken> {
  const resolved = resolveProviderOAuthConfig(provider, {
    clientId: options.clientId,
    baseUrl: options.baseUrl,
  });
  assertClientIdConfigured(resolved, provider);
  const sleep = options.sleep ?? defaultSleep;
  const deadline = Date.now() + device.expiresIn * 1000;
  let intervalS = device.interval > 0 ? device.interval : DEFAULT_DEVICE_INTERVAL_S;
  for (;;) {
    if (Date.now() >= deadline) {
      throw new AgencyError(ErrorCode.AUTH, `Device authorization expired for provider "${provider}"`, {
        source: "oauth",
      });
    }
    const res = await httpFetch(resolved.tokenUrl, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        client_id: resolved.clientId,
        device_code: device.deviceCode,
      }),
    });
    const body = (await res.json().catch(() => ({}))) as {
      access_token?: string;
      refresh_token?: string;
      expires_in?: number;
      error?: string;
    };
    if (body.access_token) {
      return {
        type: "oauth",
        accessToken: body.access_token,
        refreshToken: body.refresh_token ?? "",
        expiresAt: Date.now() + (body.expires_in ?? 3600) * 1000,
      };
    }
    if (body.error === "authorization_pending") {
      await sleep(intervalS * 1000);
      continue;
    }
    if (body.error === "slow_down") {
      intervalS += SLOW_DOWN_BACKOFF_S;
      await sleep(intervalS * 1000);
      continue;
    }
    if (body.error === "access_denied") {
      throw new AgencyError(ErrorCode.AUTH, `Device authorization denied for provider "${provider}"`, {
        source: "oauth",
      });
    }
    if (body.error === "expired_token") {
      throw new AgencyError(ErrorCode.AUTH, `Device code expired for provider "${provider}"`, {
        source: "oauth",
      });
    }
    throw new AgencyError(
      ErrorCode.AUTH,
      `Device poll failed for provider "${provider}": ${res.status} ${body.error ?? res.statusText}`,
      { source: "oauth" },
    );
  }
}

// Runs request, user-code display, poll, then stores in the oauth slot.
export async function runDeviceFlow(
  provider: string,
  keychain: KeychainBackend,
  options: DeviceFlowCallbacks = {},
): Promise<OAuthToken> {
  const device = await requestDeviceAuthorization(provider, options.httpFetch, {
    clientId: options.clientId,
    baseUrl: options.baseUrl,
  });
  options.onUserCode?.({
    userCode: device.userCode,
    verificationUri: device.verificationUriComplete ?? device.verificationUri,
  });
  const token = await pollDeviceToken(provider, device, options.httpFetch, {
    clientId: options.clientId,
    baseUrl: options.baseUrl,
    sleep: options.sleep,
  });
  await storeOAuthToken(keychain, provider, token);
  return token;
}
