import { requirePathScope } from "@agency/guard";
import type { ToolDeps, ToolSpec } from "../contract.ts";
import { clip, lineCount, str, summarize } from "../render.ts";

const MAX_RESULTS = 500;

export function createGlobTool(deps: ToolDeps): ToolSpec {
  const spec: ToolSpec<{ pattern: string; path?: string }> = {
    name: "glob",
    description: "Lists file paths matching a glob pattern, e.g. 'src/**/*.ts'.",
    inputSchema: {
      type: "object",
      properties: {
        pattern: { type: "string" },
        path: { type: "string", description: "Directory to search from; defaults to the project root." },
      },
      required: ["pattern"],
    },
    riskTier: "safe",
    renderCall: (input) => `glob ${summarize(str(input.pattern))}`,
    renderResult: (result) => {
      const pattern = str(result.input?.pattern);
      const label = pattern ? `glob ${pattern}` : "glob";
      if (result.isError) return `${label} failed: ${summarize(result.content)}`;
      const trimmed = result.content.trim();
      if (trimmed === "" || trimmed === "no files matched") return `${label}: no files matched`;
      const files = lineCount(result.content);
      return `${label}: ${files} ${files === 1 ? "file" : "files"} (${clip(result.content)})`;
    },

    async handler(input) {
      const searchRoot = deps.sandbox.resolvePath(input.path ?? ".");
      requirePathScope(deps.identity, deps.capabilities, searchRoot);

      const glob = new Bun.Glob(input.pattern);
      const results: string[] = [];
      for await (const path of glob.scan({ cwd: searchRoot })) {
        results.push(path);
        if (results.length >= MAX_RESULTS) break;
      }

      if (results.length === 0) return { content: "no files matched" };
      const suffix = results.length >= MAX_RESULTS ? `\n[truncated at ${MAX_RESULTS} results]` : "";
      return { content: results.join("\n") + suffix };
    },
  };
  return spec as unknown as ToolSpec;
}
