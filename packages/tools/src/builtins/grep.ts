import { requirePathScope } from "@agency/guard";
import type { ToolDeps, ToolSpec } from "../contract.ts";

const MAX_MATCHES = 200;

function trySpawn(args: string[]) {
  try {
    return Bun.spawn(args, { stdout: "pipe", stderr: "pipe" });
  } catch {
    return undefined;
  }
}

export function createGrepTool(deps: ToolDeps): ToolSpec {
  const spec: ToolSpec<{ pattern: string; path?: string; glob?: string }> = {
    name: "grep",
    description:
      "Searches file contents for a regex pattern using ripgrep, returning matching lines with line numbers.",
    inputSchema: {
      type: "object",
      properties: {
        pattern: { type: "string" },
        path: { type: "string", description: "Directory to search; defaults to the project root." },
        glob: { type: "string", description: "Restrict to files matching this glob, e.g. '*.ts'." },
      },
      required: ["pattern"],
    },
    riskTier: "safe",
    renderCall: (input) => `grep ${input.pattern}${input.path ? ` ${input.path}` : ""}`,

    async handler(input, ctx) {
      const searchRoot = deps.sandbox.resolvePath(input.path ?? ".");
      requirePathScope(deps.identity, deps.capabilities, searchRoot);

      const args = ["rg", "--line-number", "--no-heading", "--color", "never", "-m", String(MAX_MATCHES)];
      if (input.glob) args.push("--glob", input.glob);
      args.push(input.pattern, searchRoot);

      const proc = trySpawn(args);
      if (!proc) {
        return {
          content: "ripgrep (rg) is not installed or not on PATH; grep requires it",
          isError: true,
        };
      }

      const onAbort = () => proc.kill();
      ctx.signal.addEventListener("abort", onAbort);
      try {
        const stdout = await new Response(proc.stdout).text();
        await proc.exited;

        // rg exits 1 for "no matches", which is a normal, non-error result here.
        if (proc.exitCode !== 0 && proc.exitCode !== 1) {
          const stderr = await new Response(proc.stderr).text();
          return { content: stderr || `rg exited with code ${proc.exitCode}`, isError: true };
        }

        return { content: stdout.trim() || "no matches" };
      } finally {
        ctx.signal.removeEventListener("abort", onAbort);
      }
    },
  };
  return spec as unknown as ToolSpec;
}
