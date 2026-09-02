import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { basename, join, resolve } from "node:path";
import { connectToDaemon, type DaemonClient } from "./client.ts";
import { PROTOCOL_VERSION } from "./protocol.ts";

export interface InstanceInfo {
  port: number;
  pid: number;
  startedAt: string;
  version: number;
  /**
   * Per-instance auth token (A3): the daemon checks this on the TCP hello,
   * so knowing the port alone is not enough to execute tools. The instance
   * file is written user-only (chmod 0600 off-Windows) since it holds it.
   */
  token?: string;
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

/** Generates a fresh per-instance token (256 bits of entropy). */
export function newInstanceToken(): string {
  return randomBytes(32).toString("hex");
}

/**
 * Publishes the instance file atomically (temp + rename, so a reader never
 * sees a half-written file) and user-only where the OS supports it — the
 * file contains the auth token, so world-readability would defeat it.
 * Windows ACLs on a profile-local directory are already user-scoped; Node's
 * chmod only toggles the read-only bit there, so it's skipped.
 */
export function writeInstanceFile(path: string, info: InstanceInfo): void {
  mkdirSync(join(path, ".."), { recursive: true });
  const temp = join(join(path, ".."), `${basename(path)}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`);
  writeFileSync(temp, JSON.stringify(info, null, 2));
  try {
    if (process.platform !== "win32") chmodSync(temp, 0o600);
    renameOrReplace(temp, path);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
}

/** renameSync, tolerating a stale target on platforms that refuse overwriting. */
function renameOrReplace(from: string, to: string): void {
  try {
    rmSync(to, { force: true });
  } catch {
    // Nothing to replace.
  }
  renameSync(from, to);
}

interface SpawnLockContents {
  pid: number;
  acquiredAt: string;
}

function spawnLockPath(instanceFile: string): string {
  return `${instanceFile}.lock`;
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM"; // exists but denied
  }
}

function readSpawnLock(lockFile: string): SpawnLockContents | undefined {
  try {
    return JSON.parse(readFileSync(lockFile, "utf8")) as SpawnLockContents;
  } catch {
    return undefined;
  }
}

/**
 * O_EXCL create of the spawn lock (A3): two clients starting together must
 * not spawn two daemons. Exactly one acquirer wins; a lock whose holder is
 * dead (or older than `staleMs`) is stolen so a crashed spawner can't wedge
 * the workspace forever. Returns false when another live process holds it.
 */
function acquireSpawnLock(lockFile: string, staleMs: number): boolean {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(lockFile, "wx");
      writeSync(fd, JSON.stringify({ pid: process.pid, acquiredAt: new Date().toISOString() } satisfies SpawnLockContents));
      closeSync(fd);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const holder = readSpawnLock(lockFile);
      const holderAlive = holder !== undefined && holder.pid !== process.pid && isProcessAlive(holder.pid);
      let age = 0;
      try {
        age = Date.now() - statSync(lockFile).mtimeMs;
      } catch {
        // Vanished between EEXIST and stat: retry the create.
      }
      if (holderAlive && age < staleMs) return false;
      // Dead holder, same-process leftover, or pathologically old: steal it.
      rmSync(lockFile, { force: true });
    }
  }
  return false;
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
 *
 * Spawn race (A3): concurrent callers serialize on an O_EXCL lock file next
 * to the instance file — the winner spawns, losers poll for the instance
 * file and connect to the same daemon. A dead lock holder is detected via
 * its pid and the lock stolen, so a crashed spawner can't block startup.
 */
export async function ensureDaemon(
  options: EnsureDaemonOptions,
): Promise<{ port: number; client: DaemonClient }> {
  const connect = options.connect ?? connectToDaemon;
  const instanceFile = instanceFilePath(options.instanceDir, options.workspaceRoot);
  const lockFile = spawnLockPath(instanceFile);
  const spawnTimeoutMs = options.spawnTimeoutMs ?? 10_000;
  const pollIntervalMs = options.pollIntervalMs ?? 50;
  const lockStaleMs = Math.max(spawnTimeoutMs * 2, 30_000);

  async function tryConnect(): Promise<{ port: number; client: DaemonClient } | undefined> {
    const info = readInstanceFile(instanceFile);
    if (!info || info.version !== PROTOCOL_VERSION) return undefined;
    try {
      const client = await connect(info.port, "127.0.0.1", { token: info.token });
      return { port: info.port, client };
    } catch {
      rmSync(instanceFile, { force: true });
      return undefined;
    }
  }

  const existing = await tryConnect();
  if (existing) return existing;

  let locked = false;
  try {
    locked = acquireSpawnLock(lockFile, lockStaleMs);
    if (locked) {
      // The previous lock holder may have finished publishing the instance
      // file between our first read and acquiring the lock.
      const raced = await tryConnect();
      if (raced) return raced;
      options.spawnDaemon(instanceFile);
    }

    const deadline = Date.now() + spawnTimeoutMs;
    while (Date.now() < deadline) {
      const found = await tryConnect();
      if (found) return found;
      if (!locked) {
        // Someone else is (was) spawning: take over only if they died.
        locked = acquireSpawnLock(lockFile, lockStaleMs);
        if (locked) options.spawnDaemon(instanceFile);
      }
      await new Promise((r) => setTimeout(r, pollIntervalMs));
    }

    throw new Error(`daemon for ${options.workspaceRoot} did not become ready within the spawn timeout`);
  } finally {
    if (locked) rmSync(lockFile, { force: true });
  }
}
