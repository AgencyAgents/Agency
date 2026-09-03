import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { configDir } from "./paths.ts";

/** User data: sessions, snapshots. Never safe to delete casually. */
export function dataDir(env: NodeJS.ProcessEnv = process.env, platform: string = process.platform): string {
  if (platform === "win32") {
    return join(env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "Agency");
  }
  if (platform === "darwin") {
    return join(homedir(), "Library", "Application Support", "Agency");
  }
  return join(env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"), "agency");
}

/** Regenerable: model catalogs, tokenizer tables. Always safe to delete. */
export function cacheDir(env: NodeJS.ProcessEnv = process.env, platform: string = process.platform): string {
  if (platform === "win32") {
    return join(env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "Agency", "Cache");
  }
  if (platform === "darwin") {
    return join(homedir(), "Library", "Caches", "Agency");
  }
  return join(env.XDG_CACHE_HOME ?? join(homedir(), ".cache"), "agency");
}

export function logDir(env: NodeJS.ProcessEnv = process.env, platform: string = process.platform): string {
  return join(dataDir(env, platform), "logs");
}

/** Stable id for a workspace root, shared with the daemon instance-file hash
 *  scheme in @agency/rpc so a workspace's sessions and its daemon are keyed
 *  the same way. */
export function workspaceId(workspaceRoot: string): string {
  return createHash("sha256").update(resolve(workspaceRoot)).digest("hex").slice(0, 16);
}

export interface StoragePaths {
  /** Per-workspace, since a session belongs to one project. */
  sessionsDir: string;
  /** Global and content-addressed: identical file states across every
   *  workspace's sessions are stored once. */
  snapshotsDir: string;
  cacheDir: string;
  logsDir: string;
  configPath: string;
}

export function storagePaths(
  workspaceRoot: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: string = process.platform,
): StoragePaths {
  const data = dataDir(env, platform);
  return {
    sessionsDir: join(data, "sessions", workspaceId(workspaceRoot)),
    snapshotsDir: join(data, "snapshots"),
    cacheDir: cacheDir(env, platform),
    logsDir: logDir(env, platform),
    configPath: join(configDir(env, platform), "config.jsonc"),
  };
}

/**
 * Recursive size walk, async (A3: this can traverse tens of thousands of
 * files under dataDir; statSync-per-entry stalls whichever loop runs it).
 */
async function dirSizeBytes(dir: string): Promise<number> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return 0; // missing or unreadable dir counts as empty
  }
  let total = 0;
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      total += await dirSizeBytes(full);
    } else {
      total += (await stat(full)).size;
    }
  }
  return total;
}

export interface StorageReport {
  dataDir: string;
  dataBytes: number;
  cacheDir: string;
  cacheBytes: number;
  logsDir: string;
  logsBytes: number;
}

/** `agency storage`: size accounting by category, so users can see what's
 *  actually on disk before deciding to prune. */
export async function reportStorage(
  env: NodeJS.ProcessEnv = process.env,
  platform: string = process.platform,
): Promise<StorageReport> {
  const data = dataDir(env, platform);
  const cache = cacheDir(env, platform);
  const logs = logDir(env, platform);
  return {
    dataDir: data,
    dataBytes: await dirSizeBytes(data),
    cacheDir: cache,
    cacheBytes: await dirSizeBytes(cache),
    logsDir: logs,
    logsBytes: await dirSizeBytes(logs),
  };
}

/** `agency storage prune`: cache is always safe to delete, by construction
 *  of the data/cache split (never user data, everything in it regenerates). */
export function pruneCache(env: NodeJS.ProcessEnv = process.env, platform: string = process.platform): void {
  const dir = cacheDir(env, platform);
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
}

export interface RetentionPolicy {
  maxAgeDays?: number;
  maxTotalBytes?: number;
}

/** Deletes session files across every workspace older than the retention
 *  window, then (if still over budget) oldest-first until under the size
 *  ceiling. Never applied silently: callers decide when this runs. */
export function pruneSessions(
  policy: RetentionPolicy,
  env: NodeJS.ProcessEnv = process.env,
  platform: string = process.platform,
): { deleted: string[] } {
  const root = join(dataDir(env, platform), "sessions");
  if (!existsSync(root)) return { deleted: [] };

  const files: Array<{ path: string; mtimeMs: number; size: number }> = [];
  for (const workspace of readdirSync(root)) {
    const workspaceDir = join(root, workspace);
    if (!statSync(workspaceDir).isDirectory()) continue;
    for (const file of readdirSync(workspaceDir)) {
      if (!file.endsWith(".jsonl") || file.endsWith(".trace.jsonl")) continue;
      const full = join(workspaceDir, file);
      const stat = statSync(full);
      files.push({ path: full, mtimeMs: stat.mtimeMs, size: stat.size });
    }
  }

  const deleted: string[] = [];
  const now = Date.now();
  const maxAgeMs = policy.maxAgeDays !== undefined ? policy.maxAgeDays * 24 * 60 * 60 * 1000 : undefined;
  const removeWithSidecars = (sessionPath: string): void => {
    rmSync(sessionPath, { force: true });
    const dir = join(sessionPath, "..");
    const id = basename(sessionPath, ".jsonl");
    try {
      for (const f of readdirSync(dir)) {
        if (f === `${id}.trace.jsonl` || (f.startsWith(`${id}.`) && f.endsWith(".cassette.json"))) {
          rmSync(join(dir, f), { force: true });
          deleted.push(join(dir, f));
        }
      }
    } catch {}
  };

  const kept = files.filter((f) => {
    if (maxAgeMs !== undefined && now - f.mtimeMs > maxAgeMs) {
      removeWithSidecars(f.path);
      deleted.push(f.path);
      return false;
    }
    return true;
  });

  if (policy.maxTotalBytes !== undefined) {
    kept.sort((a, b) => a.mtimeMs - b.mtimeMs);
    let total = kept.reduce((sum, f) => sum + f.size, 0);
    for (const f of kept) {
      if (total <= policy.maxTotalBytes) break;
      removeWithSidecars(f.path);
      deleted.push(f.path);
      total -= f.size;
    }
  }

  return { deleted };
}
