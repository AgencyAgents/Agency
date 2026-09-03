import type { ToolDeps, ToolSpec } from "../contract.ts";
import type { ProcessManager } from "../process-manager.ts";
import { str, summarize } from "../render.ts";
import { parseShellOutput, type ShellConfig } from "../shell.ts";
import { t } from "@agency/i18n";
import { truncateWithSpill } from "../truncate.ts";

/**
 * Byte cap for a single bash result. The session-wide caps in
 * core/src/truncate.ts count UTF-8 bytes, so this does too: a result's
 * context cost is its byte length, not its character count. (Stated
 * explicitly, unlike the undocumented limit this mirrors.)
 */
const MAX_OUTPUT_BYTES = 30_000;

/**
 * Grace period for the in-flight output reads to settle after the abort
 * kill before the abort path gives up on them: a descendant that somehow
 * survives while holding the pipe open must not hang the tool past
 * cancellation.
 */
const ABORT_DRAIN_MS = 1_000;

/** How often a long-running foreground command emits a progress notice. */
const PROGRESS_TICK_MS = 2_000;

export interface BashState {
  cwd: string;
}

/**
 * Caps a bash result the way `truncateOutput` caps session-wide results in
 * core/src/truncate.ts: head kept, cut at a character boundary,
 * machine-readable notice appended — and the overflow spilled to a temp file
 * so nothing is silently dropped.
 */
function truncateResult(content: string): string {
  return truncateWithSpill(content, MAX_OUTPUT_BYTES, {
    truncated: (path) => t("tool.bash.truncated", { bytes: MAX_OUTPUT_BYTES, path }),
    truncatedNoSpill: t("tool.bash.truncated_no_spill", { bytes: MAX_OUTPUT_BYTES }),
  });
}

export function createBashTool(
  deps: ToolDeps,
  shell: ShellConfig,
  state: BashState,
  processManager: ProcessManager,
): ToolSpec {
  const spec: ToolSpec<{ command: string; background?: boolean; timeout?: number }> = {
    name: "bash",
    description:
      `Runs a shell command in ${shell.label}. Despite the tool's name, write commands in ` +
      `${shell.label} syntax on this platform, not bash/POSIX syntax. Working directory persists ` +
      "across calls within this session; environment variables do not. Pass background: true for " +
      "long-running processes (dev servers, watchers) instead of waiting for them to exit. Pass " +
      "timeout (milliseconds) to kill a command that may hang.",
    inputSchema: {
      type: "object",
      properties: {
        command: { type: "string" },
        background: { type: "boolean" },
        timeout: { type: "number", description: "Kill the command after this many milliseconds." },
      },
      required: ["command"],
    },
    riskTier: "dangerous",
    renderCall: (input) => `bash ${summarize(str(input.command))}`,
    renderResult: (result) =>
      result.isError
        ? `bash failed: ${summarize(result.content)}`
        : `bash: ${summarize(result.content) || "(no output)"}`,

    async handler(input, ctx) {
      deps.sandbox.checkCommand(input.command);

      if (input.background) {
        const argv = [shell.command, ...shell.buildArgs(input.command)];
        const info = processManager.spawn(argv, { cwd: state.cwd });
        return { content: t("tool.bash.background_started", { id: info.id, pid: info.pid }) };
      }

      const wrapped = shell.wrapCommand(input.command);
      const argv = [shell.command, ...shell.buildArgs(wrapped)];
      const proc = Bun.spawn(argv, { cwd: state.cwd, stdout: "pipe", stderr: "pipe" });

      // Reads start immediately and stay in flight across the race below:
      // when the kill lands the pipes close and they settle with whatever
      // the process produced before it died, so an aborted call returns its
      // partial output instead of a fabricated empty success.
      const stdoutText = new Response(proc.stdout).text();
      const stderrText = new Response(proc.stderr).text();

      const killProc = (): void => {
        // The foreground one-shot subprocess is not tracked by the
        // ProcessManager (its map holds processes meant to outlive a call),
        // but its tree-wide teardown is exactly what abort needs: shell
        // wrappers (macOS CI, `sh -c` chains) leave grandchildren that a
        // direct proc.kill(9) orphans and that then hold the output pipes
        // open. killTree is private on ProcessManager, so it is reached via
        // a cast; the guarded direct kill stays as the fallback either way.
        try {
          (processManager as unknown as { killTree(pid: number): void }).killTree(proc.pid);
        } catch {
          // private helper unreachable — the direct kill below still applies
        }
        try {
          proc.kill(9);
        } catch {
          // already exited — nothing to reap
        }
      };

      // One listener does both abort jobs (tree kill + settling the race),
      // so cleanup is a single removeEventListener in the finally block and
      // the shared per-turn signal accumulates nothing across bash calls.
      let settleAborted: () => void = () => {};
      const abortSettled = new Promise<void>((resolve) => {
        settleAborted = resolve;
      });
      let timedOut = false;
      const onAbort = (): void => {
        killProc();
        settleAborted();
      };
      if (ctx.signal.aborted) onAbort();
      else ctx.signal.addEventListener("abort", onAbort);

      const timeout =
        typeof input.timeout === "number" && Number.isFinite(input.timeout) && input.timeout > 0
          ? input.timeout
          : undefined;
      const timeoutTimer =
        timeout !== undefined
          ? setTimeout(() => {
              timedOut = true;
              killProc();
              settleAborted();
            }, timeout)
          : undefined;

      const startedAt = Date.now();
      const progressTimer = ctx.onProgress
        ? setInterval(() => {
            const seconds = Math.round((Date.now() - startedAt) / 1000);
            ctx.onProgress?.(`still running (${seconds}s)`);
          }, PROGRESS_TICK_MS)
        : undefined;

      try {
        const outcome = await Promise.race([
          Promise.all([stdoutText, stderrText, proc.exited]).then(([stdout, stderr]) => ({
            aborted: false as const,
            stdout,
            stderr,
          })),
          abortSettled.then(async () => {
            // onAbort already killed the process tree; the dying processes
            // close the pipes and the in-flight reads settle with whatever
            // was captured before the kill.
            let timer: ReturnType<typeof setTimeout> | undefined;
            const [stdout, stderr] = await Promise.race([
              Promise.all([stdoutText, stderrText]),
              new Promise<[string, string]>((resolve) => {
                timer = setTimeout(() => resolve(["", ""]), ABORT_DRAIN_MS);
              }),
            ]);
            clearTimeout(timer);
            return { aborted: true as const, stdout, stderr };
          }),
        ]);

        const { output, cwd, exitCode } = parseShellOutput(outcome.stdout, state.cwd);
        // A cancelled command keeps no cwd side-effect: its wrapper may not
        // even have run to completion, so the marker cannot be trusted.
        // The sandbox bound is what makes a persisted cwd safe to keep: a
        // `cd` that walks out of the workspace (or through a symlink) is
        // refused and the previous directory retained, otherwise every later
        // command would silently run — and write — outside containment.
        let cwdNotice: string | undefined;
        if (!outcome.aborted) {
          try {
            deps.sandbox.resolvePath(cwd);
            state.cwd = cwd;
          } catch {
            cwdNotice = `\n${t("tool.bash.cwd_kept", { cwd })}`;
          }
        }

        let combined = outcome.stderr ? `${output}\n[stderr]\n${outcome.stderr}` : output;
        if (cwdNotice) combined += cwdNotice;
        if (outcome.aborted) {
          // Cancellation must not read as a silent success with exit code 0.
          const notice = timedOut
            ? t("tool.bash.timeout", { ms: timeout ?? 0 })
            : t("tool.bash.cancelled");
          combined = combined ? `${combined}\n${notice}` : notice;
        } else if (exitCode !== 0) {
          combined += `\n${t("tool.bash.exit_code", { code: exitCode })}`;
        }

        return { content: truncateResult(combined) };
      } finally {
        ctx.signal.removeEventListener("abort", onAbort);
        if (progressTimer !== undefined) clearInterval(progressTimer);
        if (timeoutTimer !== undefined) clearTimeout(timeoutTimer);
      }
    },
  };
  return spec as unknown as ToolSpec;
}
