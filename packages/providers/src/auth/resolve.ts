import type { KeychainBackend } from "./types.ts";
import { refreshOAuthToken } from "./oauth.ts";

export interface ResolveApiKeyOptions {
  provider: string;
  /** Explicit CLI flag value, highest precedence. */
  flag?: string;
  env?: NodeJS.ProcessEnv;
  keychain?: KeychainBackend;
  /** A key set directly in a config file, lowest precedence, mainly for local dev. */
  config?: string;
  httpFetch?: typeof fetch;
}

function envKey(provider: string): string {
  return `AGENCY_${provider.toUpperCase()}_API_KEY`;
}

function oauthKey(provider: string): string {
  return `${provider}:oauth`;
}

/**
 * flag -> env -> keychain -> config, matching every other layered-resolution
 * surface in Agency. The caller MUST register whatever this returns with a
 * Redactor before it's used anywhere. Resolution and redaction are kept as
 * separate concerns, but the pairing is the point of R11 and skipping it
 * defeats the whole mechanism.
 *
 * When the keychain holds an OAuth token (JSON with type:"oauth"), the access
 * token is returned, refreshing it first if expired. Refresh is single-flight.
 */
export async function resolveApiKey(options: ResolveApiKeyOptions): Promise<string | undefined> {
  if (options.flag) return options.flag;

  const env = options.env ?? process.env;
  const fromEnv = env[envKey(options.provider)];
  if (fromEnv) return fromEnv;

  if (options.keychain) {
    const raw = await options.keychain.get(options.provider);
    if (raw) {
      try {
        const parsed = JSON.parse(raw) as Record<string, unknown>;
        if (parsed.type === "oauth") {
          const refreshed = await refreshOAuthToken(options.keychain, options.provider, options.httpFetch);
          if (refreshed) return refreshed;
          return typeof parsed.accessToken === "string" ? parsed.accessToken : raw;
        }
      } catch {}
      return raw;
    }
    const oauthRaw = await options.keychain.get(oauthKey(options.provider));
    if (oauthRaw) {
      const refreshed = await refreshOAuthToken(options.keychain, options.provider, options.httpFetch);
      if (refreshed) return refreshed;
      try {
        const parsed = JSON.parse(oauthRaw) as Record<string, unknown>;
        if (typeof parsed.accessToken === "string") return parsed.accessToken;
      } catch {}
      return oauthRaw;
    }
  }

  return options.config;
}
