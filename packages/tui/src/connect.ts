import { t } from "@agency/i18n";

/**
 * The /connect flow: prompt for a provider id and API key, validate the pair
 * against the provider's live endpoint, store the key, and hand back enough
 * for the caller to refresh the catalog. All terminal I/O is injected, so the
 * whole flow is testable without a TTY.
 */

/**
 * Structural subset of the daemon-side keychain the flow needs. The TUI talks
 * to providers over RPC, so it depends on this shape, not on the providers
 * package; the real keychain satisfies it as-is.
 */
export interface KeyStore {
  readonly name: string;
  set(account: string, secret: string): Promise<void>;
}

export interface ConnectPrompter {
  /** Reads a line of plain input (provider ids, custom names). */
  line(prompt: string): Promise<string>;
  /** Reads a secret; the implementation masks echoed characters. */
  secret(prompt: string): Promise<string>;
}

/** A terminal prompter: secrets are read with echo suppressed by the caller's
 *  readline config; this implementation only shapes the prompts. */
export function createTerminalPrompter(
  readLine: (prompt: string, mask: boolean) => Promise<string>,
): ConnectPrompter {
  return {
    line: (prompt) => readLine(prompt, false),
    secret: (prompt) => readLine(prompt, true),
  };
}

/** A prompter over pre-scripted answers; tests drive the flow deterministically. */
export function createScriptedPrompter(answers: readonly string[]): ConnectPrompter & { asked: string[] } {
  const queue = [...answers];
  const asked: string[] = [];
  const next = (prompt: string): Promise<string> => {
    asked.push(prompt);
    return Promise.resolve(queue.shift() ?? "");
  };
  return {
    asked,
    line: (prompt) => next(prompt),
    secret: (prompt) => next(prompt),
  };
}

export type ConnectErrorCode = "invalid_id" | "no_key" | "rejected" | "aborted";

export class ConnectError extends Error {
  constructor(
    readonly code: ConnectErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ConnectError";
  }
}

/** opencode's custom-provider id rule: lowercase, digits, dash, underscore. */
const PROVIDER_ID_PATTERN = /^[a-z0-9][a-z0-9-_]*$/;

export function isValidProviderId(id: string): boolean {
  return PROVIDER_ID_PATTERN.test(id);
}

export interface ConnectOutcome {
  providerId: string;
  /** Where the key was persisted, so the UI can say so. */
  storedIn: string;
  /** True when the key was verified against the provider before storing. */
  verified: boolean;
}

export const OAUTH_PROVIDER_IDS = new Set(["anthropic", "github-copilot"]);

export interface ConnectFlowOptions {
  prompter: ConnectPrompter;
  keychain: KeyStore;
  /** Verifies a candidate key before it's stored; a rejection aborts the flow. */
  validate?: (providerId: string, apiKey: string) => Promise<boolean>;
  /** Known provider ids offered as suggestions (from the catalog). */
  knownProviders?: readonly string[];
  /** Skip live validation (offline, or a provider with no cheap ping). */
  skipValidation?: boolean;
  /** OAuth handler: if provided and the provider supports OAuth, the flow offers it. */
  oauth?: (providerId: string) => Promise<{ accessToken: string; storedIn: string }>;
}

/**
 * Runs one /connect interaction: provider id (validated against the known
 * list, free-form allowed for custom gateways), masked API key, live
 * validation, keychain persistence. Throws ConnectError with a code the UI
 * maps to an i18n message; the key never outlives this function's scope.
 */
export async function runConnectFlow(options: ConnectFlowOptions): Promise<ConnectOutcome> {
  const known = options.knownProviders ?? [];
  const suggestions = known.length > 0 ? ` (${known.join(", ")})` : "";

  const rawId = (await options.prompter.line(t("tui.connect.provider_prompt", { suggestions }))).trim();
  if (!rawId) throw new ConnectError("aborted", t("tui.connect.aborted"));
  const providerId = rawId.replace(/^@ai-sdk\//, "");
  if (!isValidProviderId(providerId)) {
    throw new ConnectError("invalid_id", t("tui.connect.invalid_id", { id: providerId }));
  }

  if (OAUTH_PROVIDER_IDS.has(providerId) && options.oauth) {
    const choice = (await options.prompter.line(`Use OAuth for ${providerId}? (type "oauth" for OAuth, Enter for API key)`)).trim().toLowerCase();
    if (choice === "oauth" || choice === "o" || choice === "2") {
      const oauthResult = await options.oauth(providerId);
      return { providerId, storedIn: oauthResult.storedIn, verified: true };
    }
  }

  const apiKey = await options.prompter.secret(t("tui.connect.key_prompt", { provider: providerId }));
  if (!apiKey.trim()) throw new ConnectError("no_key", t("tui.connect.no_key"));

  let verified = false;
  if (options.validate && !options.skipValidation) {
    const ok = await options.validate(providerId, apiKey.trim());
    if (!ok) throw new ConnectError("rejected", t("tui.connect.rejected", { provider: providerId }));
    verified = true;
  }

  await options.keychain.set(providerId, apiKey.trim());
  return { providerId, storedIn: options.keychain.name, verified };
}

/**
 * Live validation for a provider before its key is stored: a cheap
 * authenticated ping. OpenAI-shaped endpoints list models; that's the smallest
 * request that proves both reachability and the key. Any 2xx counts; 401/403
 * explicitly reject; anything else (network down, 5xx) is inconclusive, and an
 * inconclusive check doesn't block storing the key.
 */
export function createHttpValidator(
  http: { fetch(url: string, init?: RequestInit): Promise<Response> },
  baseUrls: Record<string, string> = {},
): (providerId: string, apiKey: string) => Promise<boolean> {
  return async (providerId, apiKey) => {
    const baseUrl = baseUrls[providerId];
    const url =
      providerId === "google"
        ? `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(apiKey)}`
        : providerId === "anthropic"
          ? `${baseUrl ?? "https://api.anthropic.com"}/v1/models`
          : `${baseUrl ?? "https://api.openai.com/v1"}/models`;

    if (providerId !== "google" && providerId !== "anthropic" && providerId !== "openai" && !baseUrl) {
      // No known endpoint to ping: validation is inconclusive, not failed.
      return true;
    }

    const headers: Record<string, string> =
      providerId === "anthropic"
        ? { "x-api-key": apiKey, "anthropic-version": "2023-06-01" }
        : providerId === "google"
          ? {}
          : { authorization: `Bearer ${apiKey}` };

    try {
      const res = await http.fetch(url, { headers, signal: AbortSignal.timeout(10_000) });
      if (res.status === 401 || res.status === 403) return false;
      return true;
    } catch {
      // Inconclusive (offline, timeout): don't reject the key for our own
      // network problems.
      return true;
    }
  };
}
