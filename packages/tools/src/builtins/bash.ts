import { t } from "@agency/i18n";
import { AgencyError, ErrorCode } from "@agency/schema";
import { asContainerExecBackend, type SandboxWithExec } from "../container-exec.ts";
import type { ToolContext, ToolDeps, ToolResult, ToolSpec } from "../contract.ts";
import type { ProcessManager } from "../process-manager.ts";
import { str, summarize } from "../render.ts";
import { CWD_MARKER, EXIT_MARKER, parseShellOutput, type ShellConfig } from "../shell.ts";
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

/**
 * Flush window between the graceful SIGTERM of the process tree and the
 * SIGKILL of the direct shell on POSIX. TERM'd descendants need a moment to
 * flush userspace stdio buffers into the pipe and exit so the pipes close and
 * the in-flight reads settle with the partial output; the SIGKILL that
 * follows then guarantees the wrapper tail (exit-code/cwd markers) can never
 * run to a clean exit 0.
 */
const POSIX_KILL_FLUSH_MS = 250;

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

/**
 * Container branch of the bash handler. The backend owns cwd translation
 * (host paths in, mount paths on the docker CLI) and the kill; this side
 * only coerces the settled output through the shared finish so labels and
 * the cwd/error contract match the software path exactly.
 */
async function runContainerExec(
  backend: SandboxWithExec,
  argv: string[],
  cwd: string,
  ctx: ToolContext,
  timeout: number | undefined,
  finish: (
    outcome: { aborted: boolean; stdout: string; stderr: string },
    timedOut: boolean,
    normalizeCwd?: (cwd: string) => string,
  ) => ToolResult,
): Promise<ToolResult> {
  let abortFired = false;
  const onAbort = (): void => {
    abortFired = true;
  };
  if (ctx.signal.aborted) onAbort();
  else ctx.signal.addEventListener("abort", onAbort);

  const startedAt = Date.now();
  const progressTimer = ctx.onProgress
    ? setInterval(() => {
        const seconds = Math.round((Date.now() - startedAt) / 1000);
        ctx.onProgress?.(`still running (${seconds}s)`);
      }, PROGRESS_TICK_MS)
    : undefined;

  try {
    // Marker paths printed inside the container live under the mount, so
    // they map back before the shared sandbox-bound check. Best-effort by
    // design: markerless output (aborts) and escapes fall through to the
    // resolvePath verdict below, which stays the containment authority.
    const toHost = (cwd: string): string => {
      try {
        return backend.toHostPath?.(cwd) ?? cwd;
      } catch {
        return cwd;
      }
    };
    let execResult: { stdout: string; stderr: string; exitCode: number };
    try {
      execResult = await backend.exec(argv, { cwd, timeoutMs: timeout, signal: ctx.signal });
    } catch (e) {
      if (e instanceof AgencyError && e.code === ErrorCode.INTERNAL && e.context.timedOut === true) {
        const partial = (value: unknown): string => (typeof value === "string" ? value : "");
        return finish(
          { aborted: true, stdout: partial(e.context.stdout), stderr: partial(e.context.stderr) },
          true,
          toHost,
        );
      }
      throw e;
    }
    // Abort intent wins over a simultaneous clean exit, same coercion as local.
    if (abortFired) {
      return finish({ aborted: true, stdout: execResult.stdout, stderr: execResult.stderr }, false, toHost);
    }
    const completed = finish(
      { aborted: false, stdout: execResult.stdout, stderr: execResult.stderr },
      false,
      toHost,
    );
    // Docker-level failures print no shell markers, so the marker exit reads
    // 0; the exec exit is the only signal and must fail closed, never silent.
    if (
      execResult.exitCode !== 0 &&
      (!execResult.stdout.includes(EXIT_MARKER) || !execResult.stdout.includes(CWD_MARKER))
    ) {
      const note = t("tool.bash.exit_code", { code: execResult.exitCode });
      const content = completed.content ? `${completed.content}\n${note}` : note;
      return { content: truncateResult(content), isError: true as const };
    }
    return completed;
  } finally {
    ctx.signal.removeEventListener("abort", onAbort);
    if (progressTimer !== undefined) clearInterval(progressTimer);
  }
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

      const timeout =
        typeof input.timeout === "number" && Number.isFinite(input.timeout) && input.timeout > 0
          ? input.timeout
          : undefined;

      // Shared result finishing for both backends: marker parse, the
      // sandbox bound on persisted cwd, and the stderr/exit/cancel labels.
      // normalizeCwd maps container marker paths back to host paths; the
      // software path passes identity, so its behavior is untouched.
      const finish = (
        outcome: { aborted: boolean; stdout: string; stderr: string },
        timedOut: boolean,
        normalizeCwd: (cwd: string) => string = (cwd) => cwd,
      ): ToolResult => {
        const { output, cwd: markerCwd, exitCode } = parseShellOutput(outcome.stdout, state.cwd);
        const cwd = normalizeCwd(markerCwd);
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
          const notice = timedOut ? t("tool.bash.timeout", { ms: timeout ?? 0 }) : t("tool.bash.cancelled");
          combined = combined ? `${combined}\n${notice}` : notice;
        } else if (exitCode !== 0) {
          combined += `\n${t("tool.bash.exit_code", { code: exitCode })}`;
        }

        // Abort (user cancellation or timeout kill) and non-zero exit
        // surface as errors so callers react instead of continuing;
        // partial output is retained alongside the label.
        const failed = outcome.aborted || exitCode !== 0;
        return failed
          ? { content: truncateResult(combined), isError: true as const }
          : { content: truncateResult(combined) };
      };

      const container = asContainerExecBackend(deps.sandbox);
      if (container !== undefined) {
        return runContainerExec(container, argv, state.cwd, ctx, timeout, finish);
      }

      const proc = Bun.spawn(argv, { cwd: state.cwd, stdout: "pipe", stderr: "pipe" });

      // Reads start immediately and stay in flight across the race below:
      // when the kill lands the pipes close and they settle with whatever
      // the process produced before it died, so an aborted call returns its
      // partial output instead of a fabricated empty success.
      const stdoutText = new Response(proc.stdout).text();
      const stderrText = new Response(proc.stderr).text();

      const killTree = (): void => {
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
      };

      const killProc = async (): Promise<void> => {
        if (process.platform === "win32") {
          try {
            proc.kill(9);
          } catch {
            // already exited — nothing to reap
          }
          killTree();
          try {
            proc.kill(9);
          } catch {
            // already exited — nothing to reap
          }
          return;
        }
        // POSIX ordering: SIGTERM the tree FIRST, while the shell is still
        // alive and parent-child links are intact. SIGKILLing the shell first
        // reparents grandchildren to init, so the pgrep -P tree walk inside
        // killTree finds nothing; the orphaned `sleep` survives holding the
        // output pipes open, the in-flight reads never settle, the
        // ABORT_DRAIN_MS fallback resolves to empty strings, and the partial
        // output already in the pipe is lost. TERM first lets descendants
        // flush stdio into the pipe and exit so the reads settle with data;
        // the short flush window below gives them that moment, and the final
        // SIGKILL of the shell guarantees the wrapper tail (exit-code/cwd
        // markers) can never run on to a clean exit 0 after a grandchild
        // was TERM'd (which would win the completion race as an empty
        // success, without the [timeout]/[cancelled] label).
        killTree();
        try {
          proc.kill(15);
        } catch {
          // already exited — nothing to reap
        }
        await new Promise((resolve) => setTimeout(resolve, POSIX_KILL_FLUSH_MS));
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
      let abortFired = false;
      const onAbort = (): void => {
        abortFired = true;
        // Settle only after the kill sequence finishes: on POSIX that
        // includes the flush window, so the abort-branch reads below race
        // against closing pipes rather than against a shell that has not
        // been TERM'd yet.
        void killProc().then(settleAborted, settleAborted);
      };
      if (ctx.signal.aborted) onAbort();
      else ctx.signal.addEventListener("abort", onAbort);

      const timeoutTimer =
        timeout !== undefined
          ? setTimeout(() => {
              timedOut = true;
              abortFired = true;
              void killProc().then(settleAborted, settleAborted);
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
        let outcome = await Promise.race([
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
        // Abort intent wins over a simultaneous clean exit. On Linux the
        // killed shell's wrapper tail can beat SIGKILL to a marker-printed
        // exit 0 (or the abort signal can land just as the pipes close), so
        // the normal branch may win the race above even though onAbort ran.
        // Coercing here keeps the [timeout]/[cancelled] label and the
        // Phase 6 isError contract while retaining whatever partial output
        // the completed read captured.
        if (!outcome.aborted && (timedOut || abortFired)) {
          outcome = { aborted: true as const, stdout: outcome.stdout, stderr: outcome.stderr };
        }

        return finish(outcome, timedOut);
      } finally {
        ctx.signal.removeEventListener("abort", onAbort);
        if (progressTimer !== undefined) clearInterval(progressTimer);
        if (timeoutTimer !== undefined) clearTimeout(timeoutTimer);
      }
    },
  };
  return spec;
}
