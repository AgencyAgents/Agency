import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

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
      if (cur.path) entries.push({ path: cur.path, branch: cur.branch ?? "", commit: cur.commit ?? "", bare: cur.bare ?? false });
      cur = {};
    }
  }
  if (cur.path) entries.push({ path: cur.path, branch: cur.branch ?? "", commit: cur.commit ?? "", bare: cur.bare ?? false });
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
