import { requirePathScope } from "@agency/guard";
import type { ToolDeps, ToolSpec } from "../contract.ts";
import { clip, lineCount, str, summarize } from "../render.ts";

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
      "Searches file contents for a regex pattern (ripgrep if available, otherwise grep), returning matching lines with line numbers.",
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
    renderCall: (input) => `grep ${summarize(str(input.pattern))}${input.path ? ` ${str(input.path)}` : ""}`,
    renderResult: (result) => {
      const pattern = str(result.input?.pattern);
      const label = pattern ? `grep ${pattern}` : "grep";
      if (result.isError) return `${label} failed: ${summarize(result.content)}`;
      const trimmed = result.content.trim();
      if (trimmed === "" || trimmed === "no matches") return `${label}: no matches`;
      const matches = lineCount(result.content);
      return `${label}: ${matches} ${matches === 1 ? "match" : "matches"} (${clip(result.content)})`;
    },

    async handler(input, ctx) {
      const searchRoot = deps.sandbox.resolvePath(input.path ?? ".");
      requirePathScope(deps.identity, deps.capabilities, searchRoot);

      let proc = trySpawn([
        "rg",
        "--line-number",
        "--no-heading",
        "--color=never",
        "-m",
        String(MAX_MATCHES),
        ...(input.glob ? ["--glob", input.glob] : []),
        input.pattern,
        searchRoot,
      ]);

      // grep -rn matches rg's `path:line:content` output and exit-1-on-no-matches semantics.
      if (!proc) {
        proc = trySpawn([
          "grep",
          "-rn",
          "--color=never",
          "-m",
          String(MAX_MATCHES),
          ...(input.glob ? ["--include", input.glob] : []),
          input.pattern,
          searchRoot,
        ]);
      }

      if (!proc) {
        return {
          content: "neither ripgrep (rg) nor grep is installed or on PATH",
          isError: true,
        };
      }

      const onAbort = () => proc.kill();
      ctx.signal.addEventListener("abort", onAbort);
      try {
        const stdout = await new Response(proc.stdout).text();
        await proc.exited;

        // Both rg and grep exit 1 for "no matches", a normal, non-error result here.
        if (proc.exitCode !== 0 && proc.exitCode !== 1) {
          const stderr = await new Response(proc.stderr).text();
          return { content: stderr || `search exited with code ${proc.exitCode}`, isError: true };
        }

        return { content: stdout.trim() || "no matches" };
      } finally {
        ctx.signal.removeEventListener("abort", onAbort);
      }
    },
  };
  return spec as unknown as ToolSpec;
}
