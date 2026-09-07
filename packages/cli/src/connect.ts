import { t } from "@agency/i18n";

/**
 * Local connect flow (moved from packages/tui/src/connect.ts when the TUI
 * package was removed). Backend CLI onboarding owns this now; the future
 * frontend will rebuild from ErrorCode + i18n keys.
 */

export interface KeyStore {
  readonly name: string;
  set(account: string, secret: string): Promise<void>;
}

export interface ConnectPrompter {
  line(prompt: string): Promise<string>;
  secret(prompt: string): Promise<string>;
}

export function createTerminalPrompter(
  readLine: (prompt: string, mask: boolean) => Promise<string>,
): ConnectPrompter {
  return {
    line: (prompt) => readLine(prompt, false),
    secret: (prompt) => readLine(prompt, true),
  };
}

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

const PROVIDER_ID_PATTERN = /^[a-z0-9][a-z0-9-_]*$/;

export function isValidProviderId(id: string): boolean {
  return PROVIDER_ID_PATTERN.test(id);
}

export interface ConnectOutcome {
  providerId: string;
  storedIn: string;
  verified: boolean;
}

export const OAUTH_PROVIDER_IDS = new Set(["anthropic", "openai", "google", "github-copilot"]);

export interface ConnectFlowOptions {
  prompter: ConnectPrompter;
  keychain: KeyStore;
  validate?: (providerId: string, apiKey: string) => Promise<boolean>;
  knownProviders?: readonly string[];
  skipValidation?: boolean;
  oauth?: (providerId: string) => Promise<{ accessToken: string; storedIn: string }>;
}

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
    const choice = (
      await options.prompter.line(`Use OAuth for ${providerId}? (type "oauth" for OAuth, Enter for API key)`)
    )
      .trim()
      .toLowerCase();
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
      return true;
    }
  };
}
