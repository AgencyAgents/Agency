import type { ToolDeps, ToolSpec } from "../contract.ts";
import type { ProcessManager } from "../process-manager.ts";
import { parseShellOutput, type ShellConfig } from "../shell.ts";

const MAX_OUTPUT_CHARS = 30_000; // stated explicitly, unlike the undocumented limit this mirrors

export interface BashState {
  cwd: string;
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
      const onAbort = () => proc.kill("SIGKILL");
      ctx.signal.addEventListener("abort", onAbort);

      try {
        const [stdout, stderr] = await Promise.all([
          new Response(proc.stdout).text(),
          new Response(proc.stderr).text(),
          proc.exited,
        ]);

        const { output, cwd, exitCode } = parseShellOutput(stdout, state.cwd);
        state.cwd = cwd;

        let combined = stderr ? `${output}\n[stderr]\n${stderr}` : output;
        if (exitCode !== 0) combined += `\n[exit code: ${exitCode}]`;
        if (combined.length > MAX_OUTPUT_CHARS) {
          combined = `${combined.slice(0, MAX_OUTPUT_CHARS)}\n[truncated: output exceeded ${MAX_OUTPUT_CHARS} characters]`;
        }

        return { content: combined };
      } finally {
        ctx.signal.removeEventListener("abort", onAbort);
      }
    },
  };
  return spec as unknown as ToolSpec;
}
