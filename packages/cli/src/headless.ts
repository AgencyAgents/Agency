import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  collectAgentsFiles,
  collectRuleFiles,
  configDir,
  dataDir,
  foreignHookPaths,
  loadConfig,
} from "@agency/core";
import type { PermissionMode, ToolPermissionValue } from "@agency/guard";
import { t } from "@agency/i18n";
import type { ThinkingLevel } from "@agency/providers";
import {
  type DaemonClient,
  DEFAULT_SPAWN_TIMEOUT_MS,
  type EnsureDaemonOptions,
  ensureDaemon,
} from "@agency/rpc";
import type { ImageBlock, Message } from "@agency/schema";
import { clientProjectPaths } from "@agency/tools";
import type { RunTurnParams, RunTurnRpcResult, SystemPromptParts } from "./daemon.ts";

export interface RunHeadlessOptions {
  workspaceRoot: string;
  /** Defaults to `defaultInstanceDir()`. */
  instanceDir?: string;
  provider: string;
  model: string;
  systemPrompt: string;
  /** Forwarded to the daemon: compose the prompt from parts there instead. */
  systemPromptParts?: SystemPromptParts;
  prompt: string;
  images?: ImageBlock[];
  thinkingLevel?: ThinkingLevel;
  permissionMode?: PermissionMode;
  /** Permission rules of this turn: they win over those of the config. */
  permissions?: Record<string, ToolPermissionValue>;
  maxToolIterations?: number;
  budget?: RunTurnParams["budget"];
  outputSchema?: Record<string, unknown>;
  onEvent?: (event: unknown) => void;
  /** Injectable for tests; production callers never pass this. */
  daemonEntryPath?: string;
}

const DEFAULT_DAEMON_ENTRY = join(import.meta.dir, "daemon-entry.ts");

/** Hidden entrypoint command: a compiled binary re-runs itself as the daemon. */
export const DAEMON_COMMAND = "__daemon";
const STANDALONE = /^(B:[\\/]~BUN|\/\$bunfs)[\\/]/.test(Bun.main);

/** A user machine has no `bun` on PATH and no source files, so never spawn either by name. */
function daemonArgv(entry?: string): string[] {
  if (entry === undefined && STANDALONE) return [process.execPath, DAEMON_COMMAND];
  return [process.execPath, "run", entry ?? DEFAULT_DAEMON_ENTRY];
}

/** Where per-workspace daemon instance files live, alongside Agency's other data dirs. */
export function defaultInstanceDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(dataDir(env), "instances");
}

export interface HeadlessConnectOptions {
  workspaceRoot: string;
  /** Defaults to `defaultInstanceDir()`. */
  instanceDir?: string;
  connect?: EnsureDaemonOptions["connect"];
  /** Injectable for tests; production callers never pass this. */
  daemonEntryPath?: string;
  /** Log sink for progress messages (spawn, connect, trust). Defaults to console.error. */
  log?: (msg: string) => void;
}

/** True when the workspace holds content that the daemon loads only after `agency trust`. */
export function hasTrustGatedContent(workspaceRoot: string): boolean {
  return (
    collectAgentsFiles(workspaceRoot, workspaceRoot).length + collectRuleFiles(workspaceRoot).length > 0 ||
    ["plugins", "skills", "agents", "commands", "hooks", "mcp"].some((dir) =>
      existsSync(join(workspaceRoot, ".agency", dir)),
    ) ||
    existsSync(join(workspaceRoot, ".mcp.json")) ||
    [...clientProjectPaths(workspaceRoot), ...foreignHookPaths(workspaceRoot)].some((file) =>
      existsSync(file),
    ) ||
    // The skills, commands and agents of other agents load from a trusted workspace too.
    [".claude", ".agents", ".cursor", ".codex", ".pi", ".opencode", ".gemini", ".github"].some((agent) =>
      ["skills", "commands", "agents", "prompts", "plugins", "plugin", "extensions", "chatmodes"].some(
        (dir) => existsSync(join(workspaceRoot, agent, dir)),
      ),
    )
  );
}

/**
 * Finds or starts this workspace's daemon (one per workspace root) and returns
 * a handshake-complete client. Checks trust before spawning, and logs
 * spawn/connect progress to the log sink.
 */
export async function connectHeadlessClient(
  options: HeadlessConnectOptions,
): Promise<{ port: number; client: DaemonClient }> {
  const log = options.log ?? ((msg: string) => process.stderr.write(`${msg}\n`));

  // Trust check: verify the workspace is trusted before any daemon work.
  const { createFileTrustStore } = await import("@agency/guard");
  const env = process.env;
  const cfg = loadConfig({ globalDir: configDir(env), env });
  const trustStore = createFileTrustStore(join(dataDir(env), "trust.json"));
  const trusted = trustStore.isTrusted(options.workspaceRoot);
  if (!trusted && cfg.trust?.required !== false) {
    log(t("cli.trust.checking", { path: options.workspaceRoot }));
    // In headless mode, prompt on stderr so it doesn't mix with stdout output.
    log(t("cli.trust.prompt", { path: options.workspaceRoot }));
    // Read a single line from stdin for the trust decision.
    const { readSecretLine } = await import("./onboarding.ts");
    const answer = await readSecretLine("");
    if (answer.toLowerCase() === "y" || answer.toLowerCase() === "yes") {
      trustStore.trust(options.workspaceRoot);
      log(t("cli.trust.accepted", { path: options.workspaceRoot }));
    } else {
      log(t("cli.trust.denied", { path: options.workspaceRoot }));
      throw new Error(t("trust.denied"));
    }
  } else if (!trusted && hasTrustGatedContent(options.workspaceRoot)) {
    // Silence here would hide that the model runs without the project's own rules.
    log(t("cli.trust.instructions_skipped"));
  }

  return ensureDaemon({
    workspaceRoot: options.workspaceRoot,
    instanceDir: options.instanceDir ?? defaultInstanceDir(),
    connect: options.connect,
    spawnDaemon: (instanceFile) => {
      log(t("cli.daemon.spawning", { workspace: options.workspaceRoot }));
      Bun.spawn(
        [
          ...daemonArgv(options.daemonEntryPath),
          "--workspace",
          options.workspaceRoot,
          "--instance-file",
          instanceFile,
        ],
        // Detached: without it Windows kills the daemon when this CLI exits, so no later run could reuse it.
        { stdio: ["ignore", "ignore", "ignore"], detached: true },
      ).unref();
    },
  })
    .then((result) => {
      log(t("cli.daemon.connected", { port: String(result.port) }));
      return result;
    })
    .catch((error: unknown) => {
      // Wrap timeout errors with actionable diagnostics.
      if (error instanceof Error && error.message.includes("did not become ready")) {
        const entry = options.daemonEntryPath ?? DEFAULT_DAEMON_ENTRY;
        throw new Error(t("cli.daemon.timeout", { timeout: String(DEFAULT_SPAWN_TIMEOUT_MS), entry }));
      }
      throw error;
    });
}

/**
 * The non-interactive client: finds or starts this workspace's daemon, runs
 * one turn, and returns. This is the "headless/print client" P3 delivers;
 * the TUI is a different client over the same RPC surface, not a
 * prerequisite for this one to work.
 */
export async function runHeadless(options: RunHeadlessOptions): Promise<RunTurnRpcResult> {
  const { client } = await connectHeadlessClient(options);

  const turnId = randomUUID();
  // Subscribe unconditionally: per-client fanout (A3) delivers this turn's
  // deltas/heartbeats only to subscribed streams, and those arriving frames
  // are what keep the heartbeat-aware call deadline alive.
  client.subscribe(`turn.${turnId}`);
  const unsubscribe = options.onEvent ? client.on(`turn.${turnId}`, options.onEvent) : undefined;

  try {
    const content: Message["content"] = [{ type: "text", text: options.prompt }, ...(options.images ?? [])];
    const session: Message[] = [{ role: "user", content }];
    const params: RunTurnParams = {
      turnId,
      provider: options.provider,
      model: options.model,
      systemPrompt: options.systemPrompt,
      systemPromptParts: options.systemPromptParts,
      thinkingLevel: options.thinkingLevel,
      session,
      permissionMode: options.permissionMode,
      ...(options.permissions === undefined ? {} : { permissions: options.permissions }),
      maxToolIterations: options.maxToolIterations,
      ...(options.budget === undefined ? {} : { budget: options.budget }),
      ...(options.outputSchema === undefined ? {} : { outputSchema: options.outputSchema }),
      nonInteractive: true,
      ...(options.images?.length ? { images: options.images } : {}),
    };
    return (await client.call("run_turn", params)) as RunTurnRpcResult;
  } finally {
    unsubscribe?.();
    client.unsubscribe(`turn.${turnId}`);
    await client.close();
  }
}
