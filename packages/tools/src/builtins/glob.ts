import { statSync } from "node:fs";
import { join } from "node:path";
import { requirePathScope } from "@agency/guard";
import { t } from "@agency/i18n";
import type { ToolDeps, ToolSpec } from "../contract.ts";
import { loadGitignore } from "../gitignore.ts";
import { clip, lineCount, str, summarize } from "../render.ts";

const MAX_RESULTS = 500;
/** Scan bound before the mtime sort picks the newest MAX_RESULTS. */
const MAX_SCANNED = 5_000;

export function createGlobTool(deps: ToolDeps): ToolSpec {
  const spec: ToolSpec<{ pattern: string; path?: string }> = {
    name: "glob",
    description:
      "Lists file paths matching a glob pattern, e.g. 'src/**/*.ts', newest first. Honors the " +
      "search root's .gitignore and never lists .git contents.",
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

      const isIgnored = loadGitignore(searchRoot);
      // Strip leading / so patterns like /src/**/*.ts are relative to searchRoot
      const pattern = input.pattern.startsWith("/") ? input.pattern.slice(1) : input.pattern;
      const glob = new Bun.Glob(pattern);
      const scanned: Array<{ path: string; mtimeMs: number }> = [];
      for await (const rawPath of glob.scan({ cwd: searchRoot })) {
        const path = rawPath.replace(/\\/g, "/");
        if (path === ".git" || path.startsWith(".git/")) continue;
        if (isIgnored?.(path)) continue;
        let mtimeMs = 0;
        try {
          mtimeMs = statSync(join(searchRoot, path)).mtimeMs;
        } catch {
          // vanished mid-scan — list it with a zero mtime rather than failing the search
        }
        scanned.push({ path, mtimeMs });
        if (scanned.length >= MAX_SCANNED) break;
      }

      scanned.sort((a, b) => b.mtimeMs - a.mtimeMs);
      const results = scanned.slice(0, MAX_RESULTS).map((entry) => entry.path);

      if (results.length === 0) return { content: t("tool.glob.no_matches") };
      const suffix =
        scanned.length > MAX_RESULTS ? `\n${t("tool.glob.truncated", { count: MAX_RESULTS })}` : "";
      return { content: results.join("\n") + suffix };
    },
  };
  return spec;
}
