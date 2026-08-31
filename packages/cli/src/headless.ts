import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { ThinkingLevel } from "@agency/providers";
import { type DaemonClient, ensureDaemon } from "@agency/rpc";
import type { Message } from "@agency/schema";
import type { RunTurnParams, RunTurnRpcResult } from "./daemon.ts";

export interface RunHeadlessOptions {
  workspaceRoot: string;
  instanceDir: string;
  provider: string;
  model: string;
  apiKey: string;
  systemPrompt: string;
  prompt: string;
  thinkingLevel?: ThinkingLevel;
  onEvent?: (event: unknown) => void;
  /** Injectable for tests; production callers never pass this. */
  daemonEntryPath?: string;
}

const DEFAULT_DAEMON_ENTRY = join(import.meta.dir, "daemon-entry.ts");

/**
 * The non-interactive client: finds or starts this workspace's daemon, runs
 * one turn, and returns. This is the "headless/print client" P3 delivers;
 * the TUI is a different client over the same RPC surface, not a
 * prerequisite for this one to work.
 */
export async function runHeadless(options: RunHeadlessOptions): Promise<RunTurnRpcResult> {
  const { client } = await ensureDaemon({
    workspaceRoot: options.workspaceRoot,
    instanceDir: options.instanceDir,
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

  const turnId = randomUUID();
  const unsubscribe = options.onEvent ? subscribeToTurn(client, turnId, options.onEvent) : undefined;

  try {
    const session: Message[] = [{ role: "user", content: [{ type: "text", text: options.prompt }] }];
    const params: RunTurnParams = {
      turnId,
      provider: options.provider,
      model: options.model,
      apiKey: options.apiKey,
      systemPrompt: options.systemPrompt,
      thinkingLevel: options.thinkingLevel,
      session,
    };
    return (await client.call("run_turn", params)) as RunTurnRpcResult;
  } finally {
    unsubscribe?.();
    await client.close();
  }
}

function subscribeToTurn(
  client: DaemonClient,
  turnId: string,
  onEvent: (event: unknown) => void,
): () => void {
  return client.on(`turn.${turnId}`, onEvent);
}
