import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { configDir, dataDir, loadConfig } from "@agency/core";
import { t } from "@agency/i18n";
import type { ThinkingLevel } from "@agency/providers";
import { type DaemonClient, type EnsureDaemonOptions, ensureDaemon } from "@agency/rpc";
import type { ImageBlock, Message } from "@agency/schema";
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
  onEvent?: (event: unknown) => void;
  /** Injectable for tests; production callers never pass this. */
  daemonEntryPath?: string;
}

const DEFAULT_DAEMON_ENTRY = join(import.meta.dir, "daemon-entry.ts");

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
  }

  return ensureDaemon({
    workspaceRoot: options.workspaceRoot,
    instanceDir: options.instanceDir ?? defaultInstanceDir(),
    connect: options.connect,
    spawnDaemon: (instanceFile) => {
      log(t("cli.daemon.spawning", { workspace: options.workspaceRoot }));
      Bun.spawn(
        [
          "bun",
          "run",
          options.daemonEntryPath ?? DEFAULT_DAEMON_ENTRY,
          "--workspace",
          options.workspaceRoot,
          "--instance-file",
          instanceFile,
        ],
        { stdio: ["ignore", "ignore", "ignore"] },
      );
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
        throw new Error(t("cli.daemon.timeout", { timeout: "5000", entry }));
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
      ...(options.images?.length ? { images: options.images } : {}),
    };
    return (await client.call("run_turn", params)) as RunTurnRpcResult;
  } finally {
    unsubscribe?.();
    client.unsubscribe(`turn.${turnId}`);
    await client.close();
  }
}
