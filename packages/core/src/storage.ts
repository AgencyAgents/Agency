import { createHash } from "node:crypto";
import { type Dirent, existsSync, mkdirSync, rmSync } from "node:fs";
import { readdir, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, resolve, sep } from "node:path";
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
 * Subtrees listed in `exclude` (exact dirs) are skipped, so a category that
 * nests inside another (cache/logs under dataDir on win32, logs on every
 * platform) is never double-counted: each byte belongs to exactly one
 * category. Non-nested excludes never match and cost nothing.
 */
async function dirSizeBytes(dir: string, exclude: readonly string[] = []): Promise<number> {
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return 0; // missing or unreadable dir counts as empty
  }
  const prefix = (p: string): boolean => exclude.some((x) => x === p || p.startsWith(`${x}${sep}`));
  if (prefix(dir)) return 0;
  const sizes = await Promise.all(
    entries.map(async (entry) => {
      const full = join(dir, entry.name);
      if (prefix(full)) return 0;
      if (entry.isDirectory()) {
        return dirSizeBytes(full, exclude);
      }
      try {
        return (await stat(full)).size;
      } catch {
        return 0; // vanished between readdir and stat
      }
    }),
  );
  return sizes.reduce((sum, n) => sum + n, 0);
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
 *  actually on disk before deciding to prune. `dataBytes` excludes the
 *  cache and logs subtrees (both nest under dataDir on win32; logs nests on
 *  every platform), so no byte is counted twice. */
export async function reportStorage(
  env: NodeJS.ProcessEnv = process.env,
  platform: string = process.platform,
): Promise<StorageReport> {
  const data = dataDir(env, platform);
  const cache = cacheDir(env, platform);
  const logs = logDir(env, platform);
  const [dataBytes, cacheBytes, logsBytes] = await Promise.all([
    dirSizeBytes(data, [cache, logs]),
    dirSizeBytes(cache),
    dirSizeBytes(logs),
  ]);
  return {
    dataDir: data,
    dataBytes,
    cacheDir: cache,
    cacheBytes,
    logsDir: logs,
    logsBytes,
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
 *  ceiling. Sort is deterministic: primary key mtimeMs, tiebreaker path
 *  (localeCompare). Sidecar files (.trace.jsonl, .cassette.json) are removed
 *  alongside each session's main .jsonl. Never applied silently: callers
 *  decide when this runs.
 *
 *  Async: the directory walk stats every candidate concurrently
 *  (Promise.all over readdir/stat) instead of one statSync per file, so a
 *  large sessions tree doesn't stall the daemon's event loop. */
export async function pruneSessions(
  policy: RetentionPolicy,
  env: NodeJS.ProcessEnv = process.env,
  platform: string = process.platform,
): Promise<{ deleted: string[] }> {
  const root = join(dataDir(env, platform), "sessions");
  let workspaces: Dirent[];
  try {
    workspaces = await readdir(root, { withFileTypes: true });
  } catch {
    return { deleted: [] };
  }

  const perWorkspace = await Promise.all(
    workspaces
      .filter((w) => w.isDirectory())
      .map(async (w) => {
        const workspaceDir = join(root, w.name);
        let files: string[];
        try {
          files = await readdir(workspaceDir);
        } catch {
          return [];
        }
        const candidates = files.filter((f) => f.endsWith(".jsonl") && !f.endsWith(".trace.jsonl"));
        return (
          await Promise.all(
            candidates.map(async (file) => {
              const full = join(workspaceDir, file);
              try {
                const s = await stat(full);
                return s.isFile() ? [{ path: full, mtimeMs: s.mtimeMs, size: s.size }] : [];
              } catch {
                return []; // vanished mid-walk
              }
            }),
          )
        ).flat();
      }),
  );
  const files: Array<{ path: string; mtimeMs: number; size: number }> = perWorkspace.flat();

  const deleted: string[] = [];
  const now = Date.now();
  const maxAgeMs = policy.maxAgeDays !== undefined ? policy.maxAgeDays * 24 * 60 * 60 * 1000 : undefined;
  const removeWithSidecars = async (sessionPath: string): Promise<void> => {
    await rm(sessionPath, { force: true });
    const dir = join(sessionPath, "..");
    const id = basename(sessionPath, ".jsonl");
    try {
      for (const f of await readdir(dir)) {
        if (f === `${id}.trace.jsonl` || (f.startsWith(`${id}.`) && f.endsWith(".cassette.json"))) {
          await rm(join(dir, f), { force: true });
          deleted.push(join(dir, f));
        }
      }
    } catch {}
  };

  const kept: typeof files = [];
  for (const f of files) {
    if (maxAgeMs !== undefined && now - f.mtimeMs > maxAgeMs) {
      await removeWithSidecars(f.path);
      deleted.push(f.path);
    } else {
      kept.push(f);
    }
  }

  if (policy.maxTotalBytes !== undefined) {
    kept.sort((a, b) => a.mtimeMs - b.mtimeMs || a.path.localeCompare(b.path));
    let total = kept.reduce((sum, f) => sum + f.size, 0);
    for (const f of kept) {
      if (total <= policy.maxTotalBytes) break;
      await removeWithSidecars(f.path);
      deleted.push(f.path);
      total -= f.size;
    }
  }

  return { deleted };
}
