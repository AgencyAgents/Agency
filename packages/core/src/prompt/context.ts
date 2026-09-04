import { execFileSync } from "node:child_process";
import { release } from "node:os";

export interface GitStatusInfo {
  branch: string;
  dirty: boolean;
  changedFiles: number;
  detached: boolean;
}

export interface EnvironmentInfo {
  platform: string;
  cwd: string;
  date: string;
  /** Absent when the directory isn't a git repo, or git itself is unavailable. */
  git?: GitStatusInfo;
  /** Human-readable shell label (e.g. "PowerShell", "POSIX sh"): the dialect
   *  the model must write commands in. Absent when the caller doesn't know. */
  shell?: string;
}

/** Returns trimmed stdout, or null when the command fails (no git, not a
 *  repo, timeout) — callers treat null as "no git information". */
export type GitRunner = (cwd: string, args: string[]) => string | null;

export const GIT_TIMEOUT_MS = 2_000;

/** Real runner: `git` must be on PATH; any failure (ENOENT, non-zero exit for
 *  not-a-repo, timeout on a pathological status) degrades to null. */
export function defaultGitRunner(cwd: string, args: string[]): string | null {
  try {
    const out = execFileSync("git", args, {
      cwd,
      timeout: GIT_TIMEOUT_MS,
      windowsHide: true,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const trimmed = out.trim();
    return trimmed.length > 0 ? trimmed : null;
  } catch {
    return null;
  }
}

/**
 * Parses `git status --porcelain --branch`. One command answers both A9b
 * questions (branch + dirty state): the `## ` header carries the branch, every
 * remaining line is a changed path.
 */
export function parseGitStatus(output: string): GitStatusInfo | undefined {
  const lines = output
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0);
  const header = lines.find((line) => line.startsWith("## "));
  if (header === undefined) return undefined;

  let branch = header.slice(3);
  let detached = false;
  if (branch === "HEAD (no branch)") {
    detached = true;
    branch = "HEAD";
  } else if (branch.startsWith("No commits yet on ")) {
    branch = branch.slice("No commits yet on ".length);
  } else {
    const upstreamSeparator = branch.indexOf("...");
    if (upstreamSeparator >= 0) branch = branch.slice(0, upstreamSeparator);
  }

  const changedFiles = Math.max(lines.length - 1, 0);
  return { branch, dirty: changedFiles > 0, changedFiles, detached };
}

export interface GatherEnvironmentOptions {
  cwd: string;
  now?: Date;
  /** Test seam; defaults to `defaultGitRunner`. */
  git?: GitRunner;
  /** Shell label to report in the block; defaults to absent. */
  shell?: string;
}

/** Collects what the model needs to orient itself: platform, working
 *  directory, current date/time, and git state. Never throws — a hostile cwd
 *  or missing git yields a block with the git section omitted. */
export function gatherEnvironmentInfo(options: GatherEnvironmentOptions): EnvironmentInfo {
  const runGit = options.git ?? defaultGitRunner;
  const info: EnvironmentInfo = {
    platform: `${process.platform} ${release()} ${process.arch}`,
    cwd: options.cwd,
    date: formatDate(options.now ?? new Date()),
    ...(options.shell === undefined ? {} : { shell: options.shell }),
  };

  const status = runGit(options.cwd, ["status", "--porcelain", "--branch"]);
  if (status !== null) {
    const parsed = parseGitStatus(status);
    if (parsed !== undefined) info.git = parsed;
  }
  return info;
}

export function buildEnvironmentBlock(info: EnvironmentInfo): string {
  const lines = [`<environment>`, `os: ${info.platform}`, `cwd: ${info.cwd}`, `date: ${info.date}`];
  if (info.shell !== undefined) lines.push(`shell: ${info.shell}`);
  if (info.git) {
    const state = info.git.detached ? ["detached"] : [];
    state.push(
      info.git.dirty
        ? `dirty, ${info.git.changedFiles} changed file${info.git.changedFiles === 1 ? "" : "s"}`
        : "clean",
    );
    lines.push(`git: branch ${info.git.branch} (${state.join(", ")})`);
  }
  lines.push("</environment>");
  return lines.join("\n");
}

/** Local date + minute-granularity time + UTC offset, e.g.
 *  "2026-09-02 14:23 UTC+02:00" — timezone-independent of the locale. */
function formatDate(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  const offsetMinutes = -date.getTimezoneOffset();
  const sign = offsetMinutes < 0 ? "-" : "+";
  const abs = Math.abs(offsetMinutes);
  const utc = `UTC${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())} ${utc}`;
}
