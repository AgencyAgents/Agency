import { execFile, execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, rmSync } from "node:fs";
import { join, sep } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** True when running on Windows — controls whether we use attrib for read-only. */
const isWin = process.platform === "win32";

export interface WorktreeInfo {
  path: string;
  branch: string;
  commit: string;
  bare: boolean;
}

export async function listWorktrees(cwd: string): Promise<WorktreeInfo[]> {
  const { stdout } = await execFileAsync("git", ["worktree", "list", "--porcelain"], { cwd });
  const entries: WorktreeInfo[] = [];
  let cur: Partial<WorktreeInfo> = {};
  for (const line of stdout.split("\n")) {
    if (line.startsWith("worktree ")) cur.path = line.slice("worktree ".length);
    else if (line.startsWith("branch ")) cur.branch = line.slice("branch ".length);
    else if (line.startsWith("HEAD ")) cur.commit = line.slice("HEAD ".length);
    else if (line === "bare") cur.bare = true;
    else if (line === "") {
      if (cur.path)
        entries.push({
          path: cur.path,
          branch: cur.branch ?? "",
          commit: cur.commit ?? "",
          bare: cur.bare ?? false,
        });
      cur = {};
    }
  }
  if (cur.path)
    entries.push({
      path: cur.path,
      branch: cur.branch ?? "",
      commit: cur.commit ?? "",
      bare: cur.bare ?? false,
    });
  return entries;
}

export async function createWorktree(cwd: string, path: string, branch?: string): Promise<void> {
  const args = branch ? ["worktree", "add", "-b", branch, path] : ["worktree", "add", path];
  await execFileAsync("git", args, { cwd });
}

export async function removeWorktree(cwd: string, path: string, force = false): Promise<void> {
  const args = ["worktree", "remove", ...(force ? ["--force"] : []), path];
  await execFileAsync("git", args, { cwd });
}

/**
 * Restores owner-writability across a worktree previously locked down with
 * {@link makeWorktreeReadOnly}. Required before removal: `git worktree
 * remove` cannot delete read-only files (Windows read-only attribute, POSIX
 * write-less directories), so cleanup must restore first.
 *
 * @param worktreePath - Absolute path to the git worktree root.
 */
export function restoreWorktreeWritable(worktreePath: string): void {
  const { readdirSync, statSync } = require("node:fs") as typeof import("node:fs");
  const root = worktreePath.replace(/\\/g, sep);
  const restoreRecursive = (dir: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return; // permission error or gone — stop descending
    }
    for (const entry of entries) {
      const full = join(dir, entry);
      try {
        const st = statSync(full);
        if (st.isDirectory()) {
          restoreRecursive(full);
          chmodSync(full, st.mode | 0o700);
        } else {
          chmodSync(full, st.mode | 0o200);
        }
        if (isWin) {
          execFileSync("attrib", ["-r", full], { windowsHide: true });
        }
      } catch {
        // Stale symlink, race, or permission — skip.
      }
    }
  };
  restoreRecursive(root);
  if (isWin) {
    try {
      execFileSync("attrib", ["-r", root], { windowsHide: true });
    } catch {
      // best-effort: root attr is advisory, removal proceeds regardless
    }
  }
}

/**
 * Removes a read-only worktree: restores writability first (see
 * {@link restoreWorktreeWritable}) so `git worktree remove --force` can
 * delete the locked files, then removes it. If git already unregistered the
 * worktree (a previous remove deleted the metadata but not the locked
 * files), falls back to recursive delete plus `git worktree prune`.
 */
export async function removeReadOnlyWorktree(cwd: string, path: string): Promise<void> {
  restoreWorktreeWritable(path);
  try {
    await removeWorktree(cwd, path, true);
  } catch {
    rmSync(path, { recursive: true, force: true });
    try {
      await execFileAsync("git", ["worktree", "prune"], { cwd });
    } catch {
      // best-effort: the files are gone, stale metadata is harmless
    }
  }
}

/**
 * Makes a worktree read-only at the filesystem level, keeping exactly one
 * scratch directory writable. Uses chmod on POSIX and the read-only attribute
 * on Windows. The scratch dir is created inside the worktree and left writable
 * so the agent can write logs, temp files, and test output there.
 *
 * @param worktreePath - Absolute path to the git worktree root.
 * @param scratchDir   - Relative path (within the worktree) for the writable
 *                        scratch directory, e.g. ".agency/scratch/reviewer".
 * @returns The absolute path to the scratch directory.
 */
export function makeWorktreeReadOnly(worktreePath: string, scratchDir: string): string {
  // Accept Windows-style paths on any platform: backslashes are separators,
  // and on posix a raw backslash would otherwise name a phantom directory.
  const root = worktreePath.replace(/\\/g, sep);
  const rel = scratchDir.replace(/\\/g, sep);
  const scratchAbs = join(root, rel);
  mkdirSync(scratchAbs, { recursive: true });

  // Walk the worktree tree and set read-only on everything except scratch.
  setReadOnlyRecursive(root, scratchAbs);

  // Ensure the scratch dir itself and its future contents stay writable.
  chmodSync(scratchAbs, 0o755);
  if (isWin) {
    // Windows: attrib -r clears the read-only attribute so the scratch dir
    // stays writable even if a parent directory was set read-only.
    execFileSync("attrib", ["-r", scratchAbs], { windowsHide: true });
  }

  return scratchAbs;
}

function setReadOnlyRecursive(root: string, skipPath: string): void {
  const { readdirSync, statSync } = require("node:fs") as typeof import("node:fs");
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return; // permission error or gone — stop descending
  }
  for (const entry of entries) {
    const full = join(root, entry);
    // Skip the scratch directory and everything inside it.
    if (full === skipPath || full.startsWith(skipPath + sep)) continue;
    try {
      const st = statSync(full);
      if (st.isDirectory()) {
        // Recurse first, then make the directory read-only (no write/search).
        setReadOnlyRecursive(full, skipPath);
        chmodSync(full, st.mode & 0o555);
      } else {
        // Files: remove write bits.
        chmodSync(full, st.mode & 0o444);
      }
      // On Windows, also set the read-only attribute explicitly via attrib +r.
      // chmodSync on Windows translates mode bits to the read-only attribute,
      // but attrib is more reliable for directories and nested paths.
      if (isWin) {
        execFileSync("attrib", ["+r", full], { windowsHide: true });
      }
    } catch {
      // Stale symlink, race, or permission — skip.
    }
  }
}
