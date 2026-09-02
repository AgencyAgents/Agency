import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { dataDir } from "@agency/core";
import type { ThinkingLevel } from "@agency/providers";
import { type DaemonClient, type EnsureDaemonOptions, ensureDaemon } from "@agency/rpc";
import type { Message } from "@agency/schema";
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
}

/**
 * Finds or starts this workspace's daemon (one per workspace root) and returns
 * a handshake-complete client.
 */
export async function connectHeadlessClient(
  options: HeadlessConnectOptions,
): Promise<{ port: number; client: DaemonClient }> {
  return ensureDaemon({
    workspaceRoot: options.workspaceRoot,
    instanceDir: options.instanceDir ?? defaultInstanceDir(),
    connect: options.connect,
    spawnDaemon: (instanceFile) => {
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
    const session: Message[] = [{ role: "user", content: [{ type: "text", text: options.prompt }] }];
    const params: RunTurnParams = {
      turnId,
      provider: options.provider,
      model: options.model,
      systemPrompt: options.systemPrompt,
      systemPromptParts: options.systemPromptParts,
      thinkingLevel: options.thinkingLevel,
      session,
    };
    return (await client.call("run_turn", params)) as RunTurnRpcResult;
  } finally {
    unsubscribe?.();
    client.unsubscribe(`turn.${turnId}`);
    await client.close();
  }
}
