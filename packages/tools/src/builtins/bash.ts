import type { ToolDeps, ToolSpec } from "../contract.ts";
import type { ProcessManager } from "../process-manager.ts";
import { parseShellOutput, type ShellConfig } from "../shell.ts";

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

export interface BashState {
  cwd: string;
}

/**
 * Cuts a UTF-8 buffer to at most `maxBytes` bytes without splitting a
 * character: any continuation bytes (10xxxxxx) at the cut point are walked
 * back to the start of the containing character. Mirrors
 * `sliceAtCharBoundary` in core/src/truncate.ts — kept local rather than
 * imported because @agency/tools does not depend on @agency/core, and
 * adding that edge is out of scope here.
 */
function sliceAtCharBoundary(buf: Buffer, maxBytes: number): string {
  let end = Math.min(maxBytes, buf.length);
  while (end > 0) {
    const byte = buf.at(end);
    if (byte === undefined || (byte & 0xc0) !== 0x80) break;
    end -= 1;
  }
  return buf.subarray(0, end).toString("utf8");
}

/**
 * Caps a bash result the way `truncateOutput` caps session-wide results in
 * core/src/truncate.ts: head kept, cut at a character boundary,
 * machine-readable notice appended. Content within the cap is untouched.
 */
function truncateResult(content: string): string {
  const bytes = Buffer.from(content, "utf8");
  if (bytes.length <= MAX_OUTPUT_BYTES) return content;
  return `${sliceAtCharBoundary(bytes, MAX_OUTPUT_BYTES)}\n[truncated: output exceeded ${MAX_OUTPUT_BYTES} bytes]`;
}

export function createBashTool(
  deps: ToolDeps,
  shell: ShellConfig,
  state: BashState,
  processManager: ProcessManager,
): ToolSpec {
  const spec: ToolSpec<{ command: string; background?: boolean }> = {
    name: "bash",
    description:
      `Runs a shell command in ${shell.label}. Working directory persists across calls within this ` +
      "session; environment variables do not. Pass background: true for long-running processes " +
      "(dev servers, watchers) instead of waiting for them to exit.",
    inputSchema: {
      type: "object",
      properties: {
        command: { type: "string" },
        background: { type: "boolean" },
      },
      required: ["command"],
    },
    riskTier: "dangerous",
    renderCall: (input) => input.command,

    async handler(input, ctx) {
      deps.sandbox.checkCommand(input.command);

      if (input.background) {
        const argv = [shell.command, ...shell.buildArgs(input.command)];
        const info = processManager.spawn(argv, { cwd: state.cwd });
        return { content: `started background process ${info.id} (pid ${info.pid})` };
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
      const onAbort = (): void => {
        killProc();
        settleAborted();
      };
      if (ctx.signal.aborted) onAbort();
      else ctx.signal.addEventListener("abort", onAbort);

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
        if (!outcome.aborted) state.cwd = cwd;

        let combined = outcome.stderr ? `${output}\n[stderr]\n${outcome.stderr}` : output;
        if (outcome.aborted) {
          // Cancellation must not read as a silent success with exit code 0.
          combined = combined
            ? `${combined}\n[cancelled: command aborted before completion]`
            : "[cancelled: command aborted before completion]";
        } else if (exitCode !== 0) {
          combined += `\n[exit code: ${exitCode}]`;
        }

        return { content: truncateResult(combined) };
      } finally {
        ctx.signal.removeEventListener("abort", onAbort);
      }
    },
  };
  return spec as unknown as ToolSpec;
}
