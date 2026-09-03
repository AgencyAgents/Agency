#!/usr/bin/env bun
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  type Config,
  dataDir,
  loadConfig,
  parseModelRef,
  type RetentionPolicy,
  reportStorage,
  SessionStore,
  storagePaths,
} from "@agency/core";
import { t } from "@agency/i18n";
import { createKeychain, type KeychainBackend, resolveApiKey } from "@agency/providers";
import type { DaemonClient } from "@agency/rpc";
import type { Message } from "@agency/schema";
import { DEFAULT_SYSTEM_PROMPT, type RunTurnRpcResult } from "./daemon.ts";
import { debugCommand } from "./debug.ts";
import { connectHeadlessClient, type RunHeadlessOptions, runHeadless } from "./headless.ts";
import { createTerminalOnboardingPrompter, readSecretLine, runOnboarding } from "./onboarding.ts";
import { runSessionTurn } from "./session-runner.ts";
import { pruneCommand, storageCommand, whereCommand } from "./storage-commands.ts";

/**
 * Inlined at compile time by scripts/build.ts (--define); running from source
 * falls back to the package version.
 */
const VERSION = process.env.AGENCY_VERSION ?? "0.1.0";

const HELP = `Agency - production coding harness

Usage: agency [command] [options]
       agency -p <prompt> [options]

Commands:
  where                    Show every path Agency reads or writes
  storage                  Report storage sizes by category
  storage prune            Clear the cache; with retention flags, prune old sessions
  session list             List sessions for this workspace (id, created, entries)
  session delete <id>      Delete a session by id
  auth login <provider>    Store an API key for a provider in the OS keychain
  auth list                Show which providers have a resolvable key
  onboard                  First-run setup: connect, model, trust
  debug                    Write a redacted debug bundle for issue reports
  update [--rollback]      Update binary from GitHub Releases (SHA-256 verified)
  serve                    Run daemon in foreground (logging to stdout)

Options:
  -p, --print <prompt>     Run a single turn headlessly and print the result
  --workspace <path>       Workspace root (default: current directory)
  --model <provider/model> Model to use; overrides config.model
  --provider <id>          Provider for the model; overrides config.model's provider
  --continue               With -p: resume the most recent session
  --session <id>           With -p: run in (creating if needed) this session
  --format <text|json>     Output format (default: text; json is for scripting)
  --max-age-days <days>    With storage prune: delete sessions older than this
  --max-total-mb <mb>      With storage prune: delete oldest sessions until under this size
  --help, -h               Show this help
  --version, -v            Show version

Run without a command to launch the TUI.
`;

export interface ParsedArgv {
  command: string | undefined;
  subcommand: string | undefined;
  args: string[];
  workspace: string | undefined;
  model: string | undefined;
  provider: string | undefined;
  print: string | undefined;
  images: string[];
  continueLast: boolean;
  session: string | undefined;
  format: "text" | "json";
  retention: RetentionPolicy | undefined;
  help: boolean;
  version: boolean;
}

export interface EntrypointDeps {
  env?: NodeJS.ProcessEnv;
  /** Overrides the global config dir (tests). */
  configDir?: string;
  /** Overrides where session JSONL lives (tests); defaults to the workspace's sessions dir. */
  sessionsDir?: string;
  /** Overrides where daemon instance files live (tests). */
  instanceDir?: string;
  /** Overrides the keychain backend (tests). */
  keychain?: KeychainBackend;
  /** Reads the API key for `auth login`; default reads a hidden TTY line or piped stdin. */
  keyReader?: (prompt: string) => Promise<string>;
  /** Overrides runHeadless for one-shot -p turns (tests). */
  runHeadless?: (options: RunHeadlessOptions) => Promise<RunTurnRpcResult>;
  /** Overrides the daemon connection for session-backed -p turns (tests). */
  ensureClient?: (options: { workspaceRoot: string; instanceDir?: string }) => Promise<DaemonClient>;
  /** Overrides the workspace the command runs in (tests). */
  cwd?: string;
  out?: (line: string) => void;
  err?: (line: string) => void;
}

function splitFlag(arg: string): [string, string | undefined] {
  const eq = arg.indexOf("=");
  if (eq === -1) return [arg, undefined];
  return [arg.slice(0, eq), arg.slice(eq + 1)];
}

function numberValue(flag: string, raw: string): number {
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) throw new Error(t("cli.error.invalid_number", { flag }));
  return value;
}

export function parseArgv(argv: string[]): ParsedArgv {
  const parsed: ParsedArgv = {
    command: undefined,
    subcommand: undefined,
    args: [],
    workspace: undefined,
    model: undefined,
    provider: undefined,
    print: undefined,
    images: [],
    continueLast: false,
    session: undefined,
    format: "text",
    retention: undefined,
    help: false,
    version: false,
  };
  const positionals: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) break;
    if (arg === "--") {
      positionals.push(...argv.slice(i + 1));
      break;
    }
    if (!arg.startsWith("-") || arg === "-") {
      positionals.push(arg);
      continue;
    }
    const [name, inline] = splitFlag(arg);
    const value = (): string => {
      if (inline !== undefined) return inline;
      i++;
      const next = argv[i];
      if (next === undefined) throw new Error(t("cli.error.missing_value", { flag: name }));
      return next;
    };
    switch (name) {
      case "--help":
      case "-h":
        parsed.help = true;
        break;
      case "--version":
      case "-v":
        parsed.version = true;
        break;
      case "--continue":
        parsed.continueLast = true;
        break;
      case "--workspace":
        parsed.workspace = value();
        break;
      case "--model":
        parsed.model = value();
        break;
      case "--provider":
        parsed.provider = value();
        break;
      case "--session":
        parsed.session = value();
        break;
      case "-p":
      case "--print":
        parsed.print = value();
        break;
      case "--format": {
        const format = value();
        if (format !== "text" && format !== "json") throw new Error(t("cli.error.invalid_format"));
        parsed.format = format;
        break;
      }
      case "--max-age-days":
        parsed.retention ??= {};
        parsed.retention.maxAgeDays = numberValue(name, value());
        break;
      case "--max-total-mb":
        parsed.retention ??= {};
        parsed.retention.maxTotalBytes = numberValue(name, value()) * 1024 * 1024;
        break;
      case "--image":
        parsed.images.push(value());
        break;
      default:
        throw new Error(t("cli.error.unknown_option", { flag: name }));
    }
  }

  parsed.command = positionals[0];
  parsed.subcommand = positionals[1];
  parsed.args = positionals.slice(2);
  return parsed;
}

type LineSink = (line: string) => void;

function workspaceRootOf(parsed: ParsedArgv, deps: EntrypointDeps): string {
  return resolve(deps.cwd ?? process.cwd(), parsed.workspace ?? ".");
}

function envOf(deps: EntrypointDeps): NodeJS.ProcessEnv {
  return deps.env ?? process.env;
}

/**
 * The flags layer for loadConfig: `--model` is taken as the config model ref,
 * with `--provider` overriding its provider part. `--provider` alone can't
 * form a ref without a model id, so it's applied after load instead (see
 * resolveModelRef).
 */
function flagsFor(parsed: ParsedArgv): Partial<Record<keyof Config, unknown>> {
  if (parsed.model === undefined) return {};
  if (parsed.provider === undefined) return { model: parsed.model };
  const slash = parsed.model.indexOf("/");
  const modelId = slash === -1 ? parsed.model : parsed.model.slice(slash + 1);
  return { model: `${parsed.provider}/${modelId}` };
}

/** provider+model for a turn: argv wins over config.model (which already
 *  contains the flags layer). A bare --model id (no slash) is only usable
 *  together with --provider. */
function resolveModelRef(config: Config, parsed: ParsedArgv): { provider: string; model: string } {
  if (parsed.provider !== undefined && parsed.model === undefined) {
    const fromConfig = parseModelRef(config.model ?? "");
    if (!fromConfig) {
      throw new Error(t("cli.error.provider_without_model", { provider: parsed.provider }));
    }
    return { provider: parsed.provider, model: fromConfig.model };
  }
  const ref = parseModelRef(config.model ?? "");
  if (!ref) throw new Error(t("cli.error.no_model"));
  return ref;
}

/** Pre-flight credential check: declared provider env names first, then
 *  flag -> env -> keychain -> config via resolveApiKey. Since A3 the key is
 *  NOT sent to the daemon (it resolves the same layers itself) — this exists
 *  only to fail fast with a clear message before any daemon work. */
async function validateTurnKey(provider: string, config: Config, deps: EntrypointDeps): Promise<void> {
  const env = envOf(deps);
  const keychain = deps.keychain ?? (await createKeychain(process.platform, join(dataDir(env), "keys")));
  const providerConfig = config.provider[provider];
  const fromDeclaredEnv = providerConfig?.env?.map((name) => env[name]).find(Boolean);
  const key =
    fromDeclaredEnv ?? (await resolveApiKey({ provider, env, keychain, config: providerConfig?.apiKey }));
  if (key === undefined) throw new Error(t("cli.error.no_key", { provider }));
}

/** Assistant text blocks joined by newlines: what `-p` prints in text mode. */
function assistantText(messages: Message[]): string {
  const parts: string[] = [];
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    for (const block of message.content) {
      if (block.type === "text") parts.push(block.text);
    }
  }
  return parts.join("\n");
}

function printJsonOrText(out: LineSink, format: "text" | "json", payload: unknown, text: string): void {
  if (format === "json") out(JSON.stringify(payload, null, 2));
  else if (text.length > 0) out(text);
}

/** Most recently appended session: the one `--continue` resumes. Ties break
 *  by readdir order; an empty session file sorts oldest. */
function latestSessionId(store: SessionStore): string | undefined {
  let latest: { id: string; createdAt: string } | undefined;
  for (const id of store.list()) {
    const entries = store.load(id);
    const createdAt = entries[entries.length - 1]?.createdAt ?? "";
    if (latest === undefined || createdAt > latest.createdAt) latest = { id, createdAt };
  }
  return latest?.id;
}

function loadImageBlocks(paths: string[]): import("@agency/schema").ImageBlock[] {
  const blocks: import("@agency/schema").ImageBlock[] = [];
  for (const p of paths) {
    try {
      const data = readFileSync(p);
      const ext = p.split(".").pop()?.toLowerCase() ?? "";
      const mime = ext === "png" ? "image/png" : ext === "jpg" || ext === "jpeg" ? "image/jpeg" : ext === "webp" ? "image/webp" : "image/png";
      blocks.push({ type: "image", mimeType: mime, data: data.toString("base64") });
    } catch {}
  }
  return blocks;
}

/** `-p` headless mode. Without --continue/--session the turn is one-shot
 *  (runHeadless, nothing persisted); with them, the turn runs against a
 *  persisted session via runSessionTurn. Either way the process exits once
 *  the turn completes. */
async function runPrintMode(
  parsed: ParsedArgv,
  prompt: string,
  deps: EntrypointDeps,
  out: LineSink,
): Promise<number> {
  if (parsed.continueLast && parsed.session !== undefined) {
    throw new Error(t("cli.error.session_conflict"));
  }

  const workspaceRoot = workspaceRootOf(parsed, deps);
  const env = envOf(deps);
  const config = loadConfig({ globalDir: deps.configDir, env, flags: flagsFor(parsed) });
  const { provider, model } = resolveModelRef(config, parsed);
  await validateTurnKey(provider, config, deps);

  if (parsed.continueLast || parsed.session !== undefined) {
    const store = new SessionStore(deps.sessionsDir ?? storagePaths(workspaceRoot, env).sessionsDir);
    let sessionId = parsed.session;
    if (sessionId === undefined) {
      sessionId = latestSessionId(store);
      if (sessionId === undefined) throw new Error(t("cli.error.no_sessions"));
    } else if (!store.list().includes(sessionId)) {
      // An explicitly named session that doesn't exist yet is created, so the
      // turn persists under the requested id.
      store.create(sessionId);
    }

    const client = deps.ensureClient
      ? await deps.ensureClient({ workspaceRoot, instanceDir: deps.instanceDir })
      : (await connectHeadlessClient({ workspaceRoot, instanceDir: deps.instanceDir })).client;
    try {
      const images = parsed.images.length ? loadImageBlocks(parsed.images) : undefined;
      const { result, tipId } = await runSessionTurn(client, {
        store,
        sessionId,
        provider,
        model,
        systemPrompt: DEFAULT_SYSTEM_PROMPT,
        userText: prompt,
        images,
      });
      printJsonOrText(out, parsed.format, { sessionId, tipId, ...result }, assistantText(result.messages));
      return result.stopReason === "error" ? 1 : 0;
    } finally {
      await client.close();
    }
  }

  const images = parsed.images.length ? loadImageBlocks(parsed.images) : undefined;
  const result = await (deps.runHeadless ?? runHeadless)({
    workspaceRoot,
    instanceDir: deps.instanceDir,
    provider,
    model,
    systemPrompt: DEFAULT_SYSTEM_PROMPT,
    prompt,
    images,
  });
  printJsonOrText(out, parsed.format, result, assistantText(result.messages));
  return result.stopReason === "error" ? 1 : 0;
}

function whereCmd(parsed: ParsedArgv, deps: EntrypointDeps, out: LineSink): number {
  if (parsed.format === "json") {
    out(JSON.stringify(storagePaths(workspaceRootOf(parsed, deps), envOf(deps)), null, 2));
  } else {
    out(whereCommand(envOf(deps)));
  }
  return 0;
}

async function storageCmd(parsed: ParsedArgv, deps: EntrypointDeps, out: LineSink): Promise<number> {
  const env = envOf(deps);
  if (parsed.subcommand === "prune") {
    const output = pruneCommand(parsed.retention, env);
    if (parsed.format === "json") out(JSON.stringify({ result: output }, null, 2));
    else out(output);
    return 0;
  }
  if (parsed.subcommand !== undefined) {
    throw new Error(t("cli.error.unknown_command", { command: `storage ${parsed.subcommand}` }));
  }
  if (parsed.format === "json") out(JSON.stringify(await reportStorage(env), null, 2));
  else out(await storageCommand(env));
  return 0;
}

function sessionCmd(parsed: ParsedArgv, deps: EntrypointDeps, out: LineSink, err: LineSink): number {
  const store = new SessionStore(
    deps.sessionsDir ?? storagePaths(workspaceRootOf(parsed, deps), envOf(deps)).sessionsDir,
  );

  if (parsed.subcommand === "list") {
    const rows = store
      .list()
      .map((id) => {
        const entries = store.load(id);
        return { id, createdAt: entries[0]?.createdAt ?? "", entries: entries.length };
      })
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
    if (parsed.format === "json") out(JSON.stringify(rows, null, 2));
    else if (rows.length === 0) out(t("tui.browser.empty"));
    else for (const row of rows) out(`${row.id}\t${row.createdAt || "-"}\t${row.entries}`);
    return 0;
  }

  if (parsed.subcommand === "delete") {
    const id = parsed.args[0];
    if (id === undefined) {
      err(t("cli.error.session_delete_usage"));
      return 1;
    }
    if (!store.list().includes(id)) {
      err(t("cli.error.unknown_session", { id }));
      return 1;
    }
    store.delete(id);
    out(
      parsed.format === "json" ? JSON.stringify({ deleted: id }, null, 2) : t("cli.session.deleted", { id }),
    );
    return 0;
  }

  throw new Error(t("cli.error.unknown_command", { command: `session ${parsed.subcommand ?? "(none)"}` }));
}

function defaultKeyReader(prompt: string): Promise<string> {
  if (process.stdin.isTTY) return readSecretLine(prompt);
  return new Promise((resolvePiped, rejectPiped) => {
    const chunks: Buffer[] = [];
    process.stdin.on("data", (chunk: Buffer) => chunks.push(chunk));
    process.stdin.once("end", () => resolvePiped(Buffer.concat(chunks).toString("utf8").trim()));
    process.stdin.once("error", rejectPiped);
  });
}

async function authCmd(
  parsed: ParsedArgv,
  deps: EntrypointDeps,
  out: LineSink,
  err: LineSink,
): Promise<number> {
  const env = envOf(deps);
  const keychain = deps.keychain ?? (await createKeychain(process.platform, join(dataDir(env), "keys")));

  if (parsed.subcommand === "login") {
    const provider = parsed.args[0];
    if (provider === undefined) {
      err(t("cli.error.auth_login_usage"));
      return 1;
    }
    const key = await (deps.keyReader ?? defaultKeyReader)(t("cli.auth.key_prompt", { provider }));
    if (key.length === 0) {
      err(t("tui.connect.no_key"));
      return 1;
    }
    await keychain.set(provider, key);
    out(t("tui.connect.stored", { provider, backend: keychain.name }));
    return 0;
  }

  if (parsed.subcommand === "list") {
    const config = loadConfig({ globalDir: deps.configDir, env });
    const ids = [...new Set(["anthropic", "google", "openai", ...Object.keys(config.provider)])].sort();
    const rows: Array<{ provider: string; connected: boolean }> = [];
    for (const id of ids) {
      const providerConfig = config.provider[id];
      const fromDeclaredEnv = providerConfig?.env?.map((name) => env[name]).find(Boolean);
      const key =
        fromDeclaredEnv ??
        (await resolveApiKey({ provider: id, env, keychain, config: providerConfig?.apiKey }));
      rows.push({ provider: id, connected: key !== undefined });
    }
    if (parsed.format === "json") {
      out(JSON.stringify(Object.fromEntries(rows.map((r) => [r.provider, r.connected])), null, 2));
    } else {
      for (const row of rows) {
        out(
          row.connected
            ? t("cli.auth.connected", { provider: row.provider })
            : t("cli.auth.disconnected", { provider: row.provider }),
        );
      }
    }
    return 0;
  }

  throw new Error(t("cli.error.unknown_command", { command: `auth ${parsed.subcommand ?? "(none)"}` }));
}

async function dispatch(
  parsed: ParsedArgv,
  deps: EntrypointDeps,
  out: LineSink,
  err: LineSink,
): Promise<number> {
  if (parsed.help) {
    out(HELP);
    return 0;
  }
  if (parsed.version) {
    out(VERSION);
    return 0;
  }

  if (parsed.print !== undefined) {
    if (parsed.command !== undefined) throw new Error(t("cli.error.print_with_command"));
    return runPrintMode(parsed, parsed.print, deps, out);
  }
  if (parsed.continueLast || parsed.session !== undefined) {
    throw new Error(t("cli.error.continue_requires_print"));
  }

  switch (parsed.command) {
    case undefined:
      out(t("cli.tui.hint"));
      return 0;
    case "where":
      return whereCmd(parsed, deps, out);
    case "storage":
      return storageCmd(parsed, deps, out);
    case "session":
      return sessionCmd(parsed, deps, out, err);
    case "auth":
      return authCmd(parsed, deps, out, err);
    case "update": {
      const rollback = parsed.args.includes("--rollback");
      const { runUpdate } = await import("./update.ts");
      const msg = await runUpdate({ currentVersion: VERSION, rollback });
      out(msg);
      return 0;
    }
    case "serve": {
      const { runServe } = await import("./serve.ts");
      const { defaultInstanceDir } = await import("./headless.ts");
      const workspaceRoot = workspaceRootOf(parsed, deps);
      const instanceDir = deps.instanceDir ?? defaultInstanceDir(envOf(deps));
      const { join } = await import("node:path");
      const { workspaceId } = await import("@agency/core");
      const instanceFile = join(instanceDir, `${workspaceId(workspaceRoot)}.json`);
      await runServe({ workspaceRoot, instanceFile });
      return 0;
    }
    case "onboard": {
      const result = await runOnboarding({
        workspaceRoot: workspaceRootOf(parsed, deps),
        prompter: createTerminalOnboardingPrompter(),
        out,
      });
      return result.completed ? 0 : 1;
    }
    case "debug": {
      const { path } = debugCommand({ workspaceRoot: workspaceRootOf(parsed, deps), version: VERSION });
      out(t("debug.written", { path }));
      return 0;
    }
    default:
      throw new Error(t("cli.error.unknown_command", { command: String(parsed.command) }));
  }
}

export async function runEntrypoint(
  argv: string[] = process.argv.slice(2),
  deps: EntrypointDeps = {},
): Promise<number> {
  const out = deps.out ?? ((line: string) => process.stdout.write(`${line}\n`));
  const err = deps.err ?? ((line: string) => process.stderr.write(`${line}\n`));
  if (!argv.includes("--help") && !argv.includes("-h") && !argv.includes("--version")) {
    try {
      const mod = await import("./update.ts");
      mod.checkStale(VERSION).then((latest) => {
        if (latest) out(`Update available: ${VERSION} -> ${latest} (run agency update)`);
      }).catch(() => {});
    } catch {}
  }
  try {
    return await dispatch(parseArgv(argv), deps, out, err);
  } catch (error) {
    err(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

if (import.meta.main) {
  runEntrypoint().then((code) => process.exit(code));
}
