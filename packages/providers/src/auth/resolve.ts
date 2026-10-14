import { oauthKey, refreshOAuthToken } from "./oauth.ts";
import type { KeychainBackend } from "./types.ts";

export interface ResolveApiKeyOptions {
  provider: string;
  /** Explicit CLI flag value, highest precedence. */
  flag?: string;
  env?: NodeJS.ProcessEnv;
  keychain?: KeychainBackend;
  /** Variable names from `provider.<id>.env`; they win over the built-in names. */
  declaredEnv?: readonly string[];
  /** A key set directly in a config file, lowest precedence, mainly for local dev. */
  config?: string;
  httpFetch?: typeof fetch;
  /** OAuth clientId override from provider.<id>.oauth (provisioning path). */
  oauthClientId?: string;
  oauthBaseUrl?: string;
}

/** Variable names that a provider's own tools read; each other id uses <ID>_API_KEY. */
const OWN_ENV: Record<string, readonly string[]> = { google: ["GEMINI_API_KEY", "GOOGLE_API_KEY"] };

/** A POSIX shell cannot set a name with a hyphen, so an id like `my-gateway` gives MY_GATEWAY. */
function envId(provider: string): string {
  return provider.toUpperCase().replace(/[^A-Z0-9]/g, "_");
}

export function keyEnvName(provider: string): string {
  return `AGENCY_${envId(provider)}_API_KEY`;
}

function envNames(provider: string, declared: readonly string[] = []): string[] {
  return [...declared, keyEnvName(provider), ...(OWN_ENV[provider] ?? [`${envId(provider)}_API_KEY`])];
}

/**
 * flag -> env -> keychain -> config. OAuth lives in the single canonical
 * `${provider}:oauth` slot; the bare provider slot holds plain API keys.
 */
export async function resolveApiKey(options: ResolveApiKeyOptions): Promise<string | undefined> {
  if (options.flag) return options.flag;

  const env = options.env ?? process.env;
  const fromEnv = envNames(options.provider, options.declaredEnv)
    .map((name) => env[name])
    .find(Boolean);
  if (fromEnv) return fromEnv;

  if (options.keychain) {
    const overrides =
      options.oauthClientId !== undefined || options.oauthBaseUrl !== undefined
        ? { clientId: options.oauthClientId, baseUrl: options.oauthBaseUrl }
        : undefined;
    const oauthRaw = await options.keychain.get(oauthKey(options.provider));
    if (oauthRaw) {
      const refreshed = await refreshOAuthToken(
        options.keychain,
        options.provider,
        options.httpFetch,
        overrides,
      );
      if (refreshed) return refreshed;
      try {
        const parsed = JSON.parse(oauthRaw) as Record<string, unknown>;
        if (typeof parsed.accessToken === "string") return parsed.accessToken;
      } catch {}
      return oauthRaw;
    }
    const raw = await options.keychain.get(options.provider);
    if (raw) {
      try {
        const parsed = JSON.parse(raw) as Record<string, unknown>;
        if (parsed.type === "oauth") {
          const refreshed = await refreshOAuthToken(
            options.keychain,
            options.provider,
            options.httpFetch,
            overrides,
          );
          if (refreshed) return refreshed;
          return typeof parsed.accessToken === "string" ? parsed.accessToken : raw;
        }
      } catch {}
      return raw;
    }
  }

  return options.config;
}
