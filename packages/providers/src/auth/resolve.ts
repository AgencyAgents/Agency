import type { KeychainBackend } from "./types.ts";

export interface ResolveApiKeyOptions {
  provider: string;
  /** Explicit CLI flag value, highest precedence. */
  flag?: string;
  env?: NodeJS.ProcessEnv;
  keychain?: KeychainBackend;
  /** A key set directly in a config file — lowest precedence, mainly for local dev. */
  config?: string;
}

function envKey(provider: string): string {
  return `AGENCY_${provider.toUpperCase()}_API_KEY`;
}

/**
 * flag -> env -> keychain -> config, matching every other layered-resolution
 * surface in Agency. The caller MUST register whatever this returns with a
 * Redactor before it's used anywhere — resolution and redaction are kept as
 * separate concerns, but the pairing is the point of R11 and skipping it
 * defeats the whole mechanism.
 */
export async function resolveApiKey(options: ResolveApiKeyOptions): Promise<string | undefined> {
  if (options.flag) return options.flag;

  const env = options.env ?? process.env;
  const fromEnv = env[envKey(options.provider)];
  if (fromEnv) return fromEnv;

  if (options.keychain) {
    const fromKeychain = await options.keychain.get(options.provider);
    if (fromKeychain) return fromKeychain;
  }

  return options.config;
}
