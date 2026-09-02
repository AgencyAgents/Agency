import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { dataDir, loadConfig, updateGlobalConfig } from "@agency/core";
import type { TrustStore } from "@agency/guard";
import { createFileTrustStore } from "@agency/guard";
import { t } from "@agency/i18n";
import type { HttpClient } from "@agency/net";
import { createKeychain, type KeychainBackend, type ModelInfo } from "@agency/providers";
import { ConnectError, createHttpValidator, runConnectFlow } from "@agency/tui";
import { listProviders } from "./providers-list.ts";

/**
 * First-run onboarding (P8): the zero-docs path from install to a ready
 * session. Detects missing credentials, runs /connect, picks a default model,
 * and asks the trust question for the current directory. Every prompt is
 * injected, so the whole flow is scriptable in tests.
 */

export interface OnboardingPrompter {
  line(prompt: string): Promise<string>;
  secret(prompt: string): Promise<string>;
  confirm(prompt: string): Promise<boolean>;
}

export interface OnboardingOptions {
  workspaceRoot: string;
  prompter: OnboardingPrompter;
  env?: NodeJS.ProcessEnv;
  /** Overrides the global config dir (tests). */
  configDir?: string;
  keychain?: KeychainBackend;
  trustStore?: TrustStore;
  http?: HttpClient;
  /** Pre-loaded catalog models; skips the models.dev fetch (tests). */
  catalog?: readonly ModelInfo[];
  cacheDir?: string;
  out?: (line: string) => void;
}

export interface OnboardingResult {
  completed: boolean;
  connectedProvider?: string;
  model?: string;
  trusted: boolean;
}

export async function runOnboarding(options: OnboardingOptions): Promise<OnboardingResult> {
  const env = options.env ?? process.env;
  const out = options.out ?? (() => {});
  const config = loadConfig({ globalDir: options.configDir, env });

  const keychain = options.keychain ?? (await createKeychain(process.platform, join(dataDir(env), "keys")));
  const trustStore = options.trustStore ?? createFileTrustStore(join(dataDir(env), "trust.json"));
  const http = options.http;

  const list = await listProviders({
    config,
    http: http ?? { fetch: async () => new Response() },
    env,
    cacheDir: options.cacheDir,
    catalog: options.catalog,
    keychain,
  });

  let connectedProvider = list.connected[0];
  if (!connectedProvider) {
    out(t("onboarding.no_credentials"));
    try {
      const outcome = await runConnectFlow({
        prompter: options.prompter,
        keychain,
        validate: http ? createHttpValidator(http) : undefined,
        knownProviders: list.all.map((p) => p.id),
      });
      connectedProvider = outcome.providerId;
      out(t("onboarding.connect_done", { provider: outcome.providerId }));
    } catch (error) {
      if (!(error instanceof ConnectError)) throw error;
      out(t("onboarding.aborted"));
      return { completed: false, trusted: trustStore.isTrusted(options.workspaceRoot) };
    }
  } else {
    out(t("onboarding.already_connected", { provider: connectedProvider }));
  }

  const suggested = config.model ?? defaultModelRef(connectedProvider, list.default);
  const answer = (
    await options.prompter.line(t("onboarding.model_prompt", { suggested: suggested ?? "provider/model" }))
  ).trim();
  const model = answer || suggested;
  if (model) {
    updateGlobalConfig({ model }, { globalDir: options.configDir, env });
    out(t("onboarding.model_stored", { model }));
  }

  let trusted = trustStore.isTrusted(options.workspaceRoot);
  if (!trusted) {
    trusted = await options.prompter.confirm(t("onboarding.trust_prompt", { path: options.workspaceRoot }));
    if (trusted) {
      trustStore.trust(options.workspaceRoot);
    } else {
      out(t("onboarding.trust_denied"));
    }
  }

  out(t("onboarding.ready"));
  return { completed: true, connectedProvider, model, trusted };
}

function defaultModelRef(providerId: string, defaults: Record<string, string>): string | undefined {
  const modelId = defaults[providerId];
  return modelId ? `${providerId}/${modelId}` : undefined;
}

/** The real terminal prompter: plain lines via readline, secrets via a raw-mode
 *  reader that echoes asterisks and treats Ctrl+C as an empty answer. */
export function createTerminalOnboardingPrompter(): OnboardingPrompter {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return {
    line: (prompt) => rl.question(prompt),
    secret: (prompt) => readSecretLine(prompt),
    confirm: async (prompt) => {
      const answer = (await rl.question(`${prompt} [y/N] `)).trim().toLowerCase();
      return answer === "y" || answer === "yes";
    },
  };
}

/** Reads a secret from the terminal: a raw-mode reader that echoes asterisks
 *  and treats Ctrl+C as an empty answer. Shared with `agency auth login`. */
export function readSecretLine(prompt: string): Promise<string> {
  process.stdout.write(prompt);
  if (!process.stdin.isTTY) {
    return Promise.resolve("");
  }
  return new Promise((resolve) => {
    const stdin = process.stdin;
    const wasRaw = stdin.isRaw;
    stdin.setRawMode(true);
    stdin.resume();
    let input = "";
    const onData = (chunk: Buffer) => {
      const char = chunk.toString("utf8");
      if (char === "\r" || char === "\n") {
        cleanup();
        process.stdout.write("\n");
        resolve(input);
      } else if (char === "\u007f" || char === "\b") {
        input = input.slice(0, -1);
      } else if (char === "\u0003") {
        cleanup();
        process.stdout.write("\n");
        resolve("");
      } else {
        input += char;
        process.stdout.write("*");
      }
    };
    const cleanup = () => {
      stdin.setRawMode(wasRaw);
      stdin.pause();
      stdin.off("data", onData);
    };
    stdin.on("data", onData);
  });
}
