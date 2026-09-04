import { requirePathScope } from "@agency/guard";
import { t } from "@agency/i18n";
import type { ToolDeps, ToolSpec } from "../contract.ts";
import { clip, lineCount, str, summarize } from "../render.ts";

const MAX_MATCHES = 200;

/** rg and grep -rn both print matches as `path:line:content`; context lines use `-` separators. */
const MATCH_LINE = /^(.+):(\d+):/;

function trySpawn(args: string[]) {
  try {
    return Bun.spawn(args, { stdout: "pipe", stderr: "pipe" });
  } catch {
    return undefined;
  }
}

function searchBinaryAvailable(): boolean {
  for (const binary of ["rg", "grep"]) {
    try {
      const result = Bun.spawnSync([binary, "--version"], { stdout: "ignore", stderr: "ignore" });
      if (result.exitCode === 0) return true;
    } catch {
      // not on PATH
    }
  }
  return false;
}

interface CapOptions {
  maxMatches: number;
  filesOnly: boolean;
}

/**
 * Reads a search process's stdout enforcing a GLOBAL match cap: match lines
 * (every line in files-only mode) are counted across all files, and the
 * process is killed once the cap is exceeded — the per-file `-m` cap this
 * replaces let a broad search return unbounded output. Returns the text cut
 * at a line boundary plus whether the cap fired.
 */
async function readWithGlobalCap(
  stream: ReadableStream<Uint8Array>,
  options: CapOptions,
): Promise<{ text: string; capped: boolean }> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let lineStart = 0;
  let matchCount = 0;
  let capped = false;

  const countLine = (line: string): boolean => {
    if (!options.filesOnly && !MATCH_LINE.test(line)) return false;
    matchCount += 1;
    return matchCount > options.maxMatches;
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
      let index = text.indexOf("\n", lineStart);
      while (index !== -1) {
        if (countLine(text.slice(lineStart, index))) {
          capped = true;
          break;
        }
        lineStart = index + 1;
        index = text.indexOf("\n", lineStart);
      }
      if (capped) break;
    }

    if (!capped) {
      const tail = text.slice(lineStart);
      if (tail.length > 0 && countLine(tail)) capped = true;
    }
  } catch {
    // stream torn down (abort kill) — keep whatever settled
  } finally {
    if (capped) {
      text = text.slice(0, lineStart);
      try {
        await reader.cancel();
      } catch {
        // pipe already closed by the kill
      }
    }
  }

  return { text, capped };
}

export function createGrepTool(deps: ToolDeps): ToolSpec {
  const spec: ToolSpec<{
    pattern: string;
    path?: string;
    glob?: string;
    caseInsensitive?: boolean;
    context?: number;
    type?: string;
    filesOnly?: boolean;
  }> = {
    name: "grep",
    description:
      "Searches file contents for a regex pattern (ripgrep if available, otherwise grep), returning " +
      "matching lines with line numbers under a global 200-match cap. Optional: caseInsensitive, " +
      "context (matching lines shown around each match), filesWithMatches (list file paths only). " +
      "type (e.g. 'ts', 'rs') restricts by file type and requires ripgrep.",
    inputSchema: {
      type: "object",
      properties: {
        pattern: { type: "string" },
        path: { type: "string", description: "Directory to search; defaults to the project root." },
        glob: { type: "string", description: "Restrict to files matching this glob, e.g. '*.ts'." },
        caseInsensitive: { type: "boolean" },
        context: { type: "integer", description: "Lines of context around each match." },
        type: { type: "string", description: "File type filter (ripgrep only), e.g. 'ts'." },
        filesOnly: { type: "boolean", description: "List matching file paths instead of lines." },
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

      if (!searchBinaryAvailable()) {
        return {
          content: t("tool.grep.no_search_binary"),
          isError: true,
        };
      }

      const context =
        typeof input.context === "number" && Number.isInteger(input.context) && input.context > 0
          ? input.context
          : undefined;
      const filesOnly = input.filesOnly === true;
      const rgArgs = [
        "rg",
        ...(filesOnly ? ["--files-with-matches"] : ["--line-number", "--no-heading"]),
        "--color=never",
        ...(input.caseInsensitive ? ["-i"] : []),
        ...(context !== undefined && !filesOnly ? ["-C", String(context)] : []),
        ...(input.type ? ["--type", input.type] : []),
        ...(input.glob ? ["--glob", input.glob] : []),
        input.pattern,
        searchRoot,
      ];

      let proc = trySpawn(rgArgs);

      // grep -rn matches rg's `path:line:content` output and exit-1-on-no-matches semantics.
      if (!proc) {
        if (input.type) {
          return {
            content: "the type filter requires ripgrep (rg), which is not installed or on PATH",
            isError: true,
          };
        }
        proc = trySpawn([
          "grep",
          filesOnly ? "-rl" : "-rn",
          "--color=never",
          ...(input.caseInsensitive ? ["-i"] : []),
          ...(context !== undefined && !filesOnly ? ["-C", String(context)] : []),
          ...(input.glob ? ["--include", input.glob] : []),
          input.pattern,
          searchRoot,
        ]);
      }

      if (!proc) {
        return {
          content: t("tool.grep.no_search_binary"),
          isError: true,
        };
      }

      const onAbort = () => proc.kill();
      ctx.signal.addEventListener("abort", onAbort);
      try {
        const { text: stdout, capped } = await readWithGlobalCap(proc.stdout, {
          maxMatches: MAX_MATCHES,
          filesOnly,
        });
        if (capped) {
          try {
            proc.kill();
          } catch {
            // already exited
          }
        }
        await proc.exited;

        // Both rg and grep exit 1 for "no matches", a normal, non-error result here.
        // A capped run was killed on purpose, so its exit code is not an error.
        if (!capped && proc.exitCode !== 0 && proc.exitCode !== 1) {
          const stderr = await new Response(proc.stderr).text();
          return { content: stderr || `search exited with code ${proc.exitCode}`, isError: true };
        }

        const trimmed = stdout.trim();
        if (trimmed === "") return { content: t("tool.grep.no_matches") };
        const notice = capped
          ? `\n${filesOnly ? t("tool.grep.truncated_files", { count: MAX_MATCHES }) : t("tool.grep.truncated", { count: MAX_MATCHES })}`
          : "";
        return { content: trimmed + notice };
      } finally {
        ctx.signal.removeEventListener("abort", onAbort);
      }
    },
  };
  return spec as unknown as ToolSpec;
}
