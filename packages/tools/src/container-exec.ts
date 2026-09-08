import type { SandboxBackend } from "@agency/guard";

/** Result of one container exec run: captured streams plus the process exit code. */
export interface ContainerExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/** Options the bash tool forwards per call; cwd stays a host path, translation is exec's job. */
export interface ContainerExecOptions {
  cwd?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}

/**
 * Optional container-exec surface a SandboxBackend may provide next to the
 * policy seam. Structural on purpose: future backends satisfy it without any
 * handler importing a concrete Docker class.
 */
export interface ContainerExecBackend {
  exec(argv: string[], opts?: ContainerExecOptions): Promise<ContainerExecResult>;
  /**
   * Maps a container-absolute path (e.g. a cwd marker printed inside the
   * container) back to its host path. Absent on backends without a mount.
   */
  toHostPath?(containerPath: string): string;
}

export type SandboxWithExec = SandboxBackend & ContainerExecBackend;

/** Narrows a backend to the exec surface via an `in` guard, never a class import. */
export function asContainerExecBackend(sandbox: SandboxBackend): SandboxWithExec | undefined {
  if ("exec" in sandbox && typeof (sandbox as { exec?: unknown }).exec === "function") {
    return sandbox as SandboxWithExec;
  }
  return undefined;
}

/** Options for a streamed child; cwd stays a host path, translation is the backend's job. */
export interface ContainerStdioOptions {
  cwd?: string;
  env?: Record<string, string>;
}

/** Long-lived piped child behind the mount: the subset of Bun.spawn the MCP stdio transport drives. */
export interface ContainerStdioChild {
  readonly stdin: unknown;
  readonly stdout: unknown;
  readonly stderr: unknown;
  readonly exited: Promise<number>;
  readonly pid?: number;
  kill(): void;
}

/**
 * Optional streaming spawn surface next to the one-shot exec seam. Separate
 * capability on purpose: exec runs a command to completion, MCP stdio needs a
 * bidirectional pipe for the server's lifetime. Backends offering only exec
 * stay valid; stdio consumers fail closed via the guard below.
 */
export interface ContainerStdioBackend {
  spawnStdio(argv: string[], opts?: ContainerStdioOptions): Promise<ContainerStdioChild>;
}

export type SandboxWithStdio = SandboxBackend & ContainerStdioBackend;

/** Narrows a backend to the streaming spawn surface via an `in` guard, never a class import. */
export function asContainerStdioBackend(sandbox: SandboxBackend): SandboxWithStdio | undefined {
  if ("spawnStdio" in sandbox && typeof (sandbox as { spawnStdio?: unknown }).spawnStdio === "function") {
    return sandbox as SandboxWithStdio;
  }
  return undefined;
}
