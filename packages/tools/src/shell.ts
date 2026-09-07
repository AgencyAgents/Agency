import { join } from "node:path";

export type WindowsShellKind = "powershell" | "gitbash" | "cmd";

/**
 * Resolved by absolute path rather than PATH lookup: a minimal or restricted
 * shell (some CI runners, sandboxed containers) may not have System32 on
 * PATH at all, and both live at this fixed location on every supported
 * Windows version regardless.
 */
function systemRoot(): string {
  return process.env.SystemRoot ?? "C:\\Windows";
}

/** Prefixes the captured cwd/exit-code lines so they can be found and
 *  stripped out of what's actually returned to the model as output. */
export const CWD_MARKER = "__AGENCY_CWD__";
export const EXIT_MARKER = "__AGENCY_EXIT__";

export interface ShellConfig {
  /** The executable to spawn. */
  command: string;
  /** Wraps the user's command string into argv for that shell. */
  buildArgs: (command: string) => string[];
  /**
   * Composes the user's command with trailing exit-code and cwd-capture
   * steps (each call spawns a fresh process rather than keeping a shell
   * alive across calls, so both have to be read back explicitly to persist
   * or surface correctly) and, on Windows, a UTF-8 encoding fix-up so
   * non-ASCII output doesn't come back garbled from an OEM/ANSI codepage
   * mismatch. The exit code is captured immediately after the user's
   * command, before any wrapper statement can overwrite it: the wrapper
   * process's own final exit code is not the user command's exit code.
   */
  wrapCommand: (userCommand: string) => string;
  /** A short, human-readable name to state in the system prompt so the model
   *  writes commands in the right dialect instead of defaulting to bash. */
  label: string;
}

const POSIX: ShellConfig = {
  command: "/bin/sh",
  buildArgs: (command) => ["-c", command],
  wrapCommand: (userCommand) =>
    `${userCommand}\n` +
    `__agency_exit=$?\n` +
    `printf '\\n${EXIT_MARKER}%s\\n' "$__agency_exit"\n` +
    `printf '${CWD_MARKER}%s\\n' "$(pwd)"`,
  label: "POSIX sh",
};

const POWERSHELL: ShellConfig = {
  command: join(systemRoot(), "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
  buildArgs: (command) => ["-NoProfile", "-Command", command],
  wrapCommand: (userCommand) =>
    `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8\n` +
    `${userCommand}\n` +
    `$__agency_exit = if ($null -ne $LASTEXITCODE) { $LASTEXITCODE } elseif ($?) { 0 } else { 1 }\n` +
    `Write-Output ("${EXIT_MARKER}" + $__agency_exit)\n` +
    `Write-Output ("${CWD_MARKER}" + (Get-Location).Path)`,
  label: "PowerShell",
};

const GIT_BASH: ShellConfig = {
  command: "bash.exe",
  buildArgs: (command) => ["-c", command],
  wrapCommand: (userCommand) =>
    `${userCommand}\n` +
    `__agency_exit=$?\n` +
    `printf '\\n${EXIT_MARKER}%s\\n' "$__agency_exit"\n` +
    `printf '${CWD_MARKER}%s\\n' "$(pwd)"`,
  label: "Git Bash",
};

const CMD: ShellConfig = {
  command: join(systemRoot(), "System32", "cmd.exe"),
  // /v:on enables !VAR! delayed expansion, without which %ERRORLEVEL% on a
  // chained line expands once at parse time (before the command runs) and
  // always reads the *previous* command's exit code, not this one's.
  buildArgs: (command) => ["/d", "/v:on", "/c", command],
  wrapCommand: (userCommand) =>
    `chcp 65001>nul & ${userCommand} & echo ${EXIT_MARKER}!ERRORLEVEL! & echo ${CWD_MARKER}%cd%`,
  label: "cmd.exe",
};

/**
 * Resolves which shell the bash tool actually spawns. On Windows this is a
 * real, previously-open bug class in mature harnesses: the model defaults to
 * Unix syntax against whatever shell happens to be selected, and cmd.exe in
 * particular silently truncates multiline/quoted constructs instead of
 * erroring. Stating the resolved shell explicitly in the system prompt (done
 * by the caller, not here) is the mitigation; this module just makes the
 * choice a real, named, configurable value instead of an assumption.
 */
export function resolveShell(platform: string, windowsShell: WindowsShellKind = "powershell"): ShellConfig {
  if (platform !== "win32") return POSIX;
  switch (windowsShell) {
    case "powershell":
      return POWERSHELL;
    case "gitbash":
      return GIT_BASH;
    case "cmd":
      return CMD;
  }
}

export interface ParsedShellOutput {
  output: string;
  cwd: string;
  exitCode: number;
}

/** Splits the exit-code and cwd marker lines back out of raw shell output. */
export function parseShellOutput(rawOutput: string, fallbackCwd: string): ParsedShellOutput {
  const cwdIndex = rawOutput.lastIndexOf(CWD_MARKER);
  const beforeCwd = cwdIndex === -1 ? rawOutput : rawOutput.slice(0, cwdIndex);
  const cwdLine =
    cwdIndex === -1
      ? undefined
      : rawOutput
          .slice(cwdIndex + CWD_MARKER.length)
          .split(/\r?\n/)[0]
          ?.trim();

  const exitIndex = beforeCwd.lastIndexOf(EXIT_MARKER);
  const output = exitIndex === -1 ? beforeCwd : beforeCwd.slice(0, exitIndex);
  const exitLine =
    exitIndex === -1
      ? undefined
      : beforeCwd
          .slice(exitIndex + EXIT_MARKER.length)
          .split(/\r?\n/)[0]
          ?.trim();

  return {
    output: output.replace(/\r?\n$/, ""),
    cwd: cwdLine || fallbackCwd,
    exitCode: exitLine !== undefined && exitLine !== "" ? Number.parseInt(exitLine, 10) : 0,
  };
}
