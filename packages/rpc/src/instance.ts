import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { connectToDaemon, type DaemonClient } from "./client.ts";
import { PROTOCOL_VERSION } from "./protocol.ts";

export interface InstanceInfo {
  port: number;
  pid: number;
  startedAt: string;
  version: number;
}

/** Stable, filesystem-safe id for a workspace root: one daemon per root (R1). */
export function hashWorkspaceRoot(workspaceRoot: string): string {
  return createHash("sha256").update(resolve(workspaceRoot)).digest("hex").slice(0, 16);
}

function instanceFilePath(instanceDir: string, workspaceRoot: string): string {
  return join(instanceDir, `${hashWorkspaceRoot(workspaceRoot)}.json`);
}

function readInstanceFile(path: string): InstanceInfo | undefined {
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as InstanceInfo;
  } catch {
    return undefined;
  }
}

export function writeInstanceFile(path: string, info: InstanceInfo): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, JSON.stringify(info, null, 2));
}

export interface EnsureDaemonOptions {
  workspaceRoot: string;
  instanceDir: string;
  /** Starts a daemon process (however the caller does that) that will write
   *  its own instance file to `instanceFile` once listening. */
  spawnDaemon: (instanceFile: string) => void;
  pollIntervalMs?: number;
  spawnTimeoutMs?: number;
  /** Injectable for tests; production callers never need to pass this. */
  connect?: typeof connectToDaemon;
}

/**
 * Finds or starts the one daemon for this workspace root. A stale instance
 * file (daemon crashed without cleanup) is detected by a failed connection
 * and cleared before spawning a replacement, so a dead daemon never
 * silently strands new clients.
 */
export async function ensureDaemon(
  options: EnsureDaemonOptions,
): Promise<{ port: number; client: DaemonClient }> {
  const connect = options.connect ?? connectToDaemon;
  const instanceFile = instanceFilePath(options.instanceDir, options.workspaceRoot);

  const existing = readInstanceFile(instanceFile);
  if (existing) {
    try {
      const client = await connect(existing.port);
      return { port: existing.port, client };
    } catch {
      rmSync(instanceFile, { force: true });
    }
  }

  options.spawnDaemon(instanceFile);

  const pollIntervalMs = options.pollIntervalMs ?? 50;
  const deadline = Date.now() + (options.spawnTimeoutMs ?? 10_000);

  while (Date.now() < deadline) {
    const info = readInstanceFile(instanceFile);
    if (info && info.version === PROTOCOL_VERSION) {
      try {
        const client = await connect(info.port);
        return { port: info.port, client };
      } catch {
        // Instance file appeared before the listener was actually ready; retry.
      }
    }
    await new Promise((r) => setTimeout(r, pollIntervalMs));
  }

  throw new Error(`daemon for ${options.workspaceRoot} did not become ready within the spawn timeout`);
}
