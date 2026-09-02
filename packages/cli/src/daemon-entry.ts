#!/usr/bin/env bun
import { logDir } from "@agency/core";
import { createAgentDaemon } from "./daemon.ts";

/**
 * The actual process `ensureDaemon`'s spawnDaemon callback starts. Parses its
 * own argv rather than receiving options directly, because it runs as a
 * separate OS process, and nothing in memory crosses that boundary.
 */
function parseArgs(argv: string[]): { workspaceRoot: string; instanceFile: string; idleLingerMs?: number } {
  const get = (flag: string): string | undefined => {
    const index = argv.indexOf(flag);
    return index === -1 ? undefined : argv[index + 1];
  };

  const workspaceRoot = get("--workspace");
  const instanceFile = get("--instance-file");
  if (!workspaceRoot || !instanceFile) {
    throw new Error("daemon-entry requires --workspace <path> and --instance-file <path>");
  }

  const idleLingerRaw = get("--idle-linger-ms");
  return { workspaceRoot, instanceFile, idleLingerMs: idleLingerRaw ? Number(idleLingerRaw) : undefined };
}

if (import.meta.main) {
  const { workspaceRoot, instanceFile, idleLingerMs } = parseArgs(process.argv.slice(2));

  const daemon = await createAgentDaemon({
    workspaceRoot,
    instanceFile,
    idleLingerMs,
    logsDir: logDir(),
    // Idle shutdown must leave through stop() — a bare process.exit(0)
    // orphans MCP servers and dev servers exactly like a missing signal
    // handler does.
    onIdleShutdown: () => {
      void shutdown();
    },
  });

  let stopping = false;
  async function shutdown() {
    if (stopping) return;
    stopping = true;
    try {
      await daemon.stop();
    } catch {
      // best effort; fall through to exit
    }
    process.exit(0);
  }

  // In production nothing ever called stop(): SIGTERM/SIGINT killed the
  // process with MCP servers and dev servers still running as orphans.
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.on(signal, () => {
      void shutdown();
    });
  }

  // Keep the process alive; startDaemonServer's socket listener does that on
  // its own, but state this explicitly rather than relying on an implicit
  // side effect if the transport ever changes.
  await new Promise(() => {});
}
