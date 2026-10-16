import { Channel, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

export interface Project {
  path: string;
  name: string;
}

export type DaemonFrame =
  | { kind: "status"; state: "connecting" | "up" | "down"; error?: string | null }
  | { kind: "event"; id: string | null; event: string; data: unknown };

export interface GitFile {
  path: string;
  status: string;
  added: number | null;
  deleted: number | null;
}

export interface GitStatus {
  repo: boolean;
  branch?: string;
  branches?: string[];
  ahead?: number;
  behind?: number;
  lastCommit?: { hash: string; subject: string; when: string };
  files?: GitFile[];
}

export interface GitDiff {
  diff: string;
  untracked: { path: string; text: string | null }[];
}

export interface UpdateInfo {
  version: string;
  current: string;
  notes?: string | null;
}

export type UpdateProgress =
  | { phase: "download"; received: number; total: number | null }
  | { phase: "install" };

/** What a failed host call rejects with: the daemon's `{ message, code }`, or a plain string from the host. */
export function errorText(error: unknown): string {
  if (typeof error === "string") return error;
  if (error && typeof error === "object" && "message" in error)
    return String((error as { message: unknown }).message);
  return String(error);
}

export function errorCode(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error
    ? String((error as { code: unknown }).code)
    : undefined;
}

export const host = {
  projects: () => invoke<Project[]>("projects_list"),
  addProject: (path: string) => invoke<Project>("projects_add", { path }),
  removeProject: (path: string) => invoke<void>("projects_remove", { path }),
  /** A folder passed on the command line: at startup, or to a second launch that focused this window. */
  launchPath: () => invoke<string | null>("launch_path"),
  onOpenPath: (fn: (path: string) => void) => listen<string>("open-path", (e) => fn(e.payload)),

  connect(root: string, onFrame: (frame: DaemonFrame) => void): Promise<void> {
    const channel = new Channel<DaemonFrame>();
    channel.onmessage = onFrame;
    return invoke("daemon_connect", { root, onEvent: channel });
  },
  restart: (root: string) => invoke<void>("daemon_restart", { root }),
  rpc: <T>(root: string, method: string, params: Record<string, unknown> = {}) =>
    invoke<T>("rpc", { root, method, params }),

  gitStatus: (root: string) => invoke<GitStatus>("git_status", { root }),
  gitDiff: (root: string) => invoke<GitDiff>("git_diff", { root }),
  gitCommit: (root: string, message: string, paths: string[]) =>
    invoke<string>("git_commit", { root, message, paths }),
  gitPush: (root: string) => invoke<void>("git_push", { root }),
  gitSwitch: (root: string, branch: string) => invoke<void>("git_switch", { root, branch }),
  prCreate: (root: string) => invoke<string>("pr_create", { root }),
  files: (root: string) => invoke<string[]>("files_list", { root }),
  openIn: (root: string, target: "vscode" | "zed" | "files" | "terminal") =>
    invoke<void>("open_in", { root, target }),
  trust: (root: string) => invoke<void>("trust", { root }),

  updateCheck: () => invoke<UpdateInfo | null>("update_check"),
  updateInstall(onProgress: (progress: UpdateProgress) => void): Promise<void> {
    const channel = new Channel<UpdateProgress>();
    channel.onmessage = onProgress;
    return invoke("update_install", { onProgress: channel });
  },
};
