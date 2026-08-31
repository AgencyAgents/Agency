import { readFileSync, statSync } from "node:fs";
import { requirePathScope } from "@agency/guard";
import type { ToolDeps, ToolSpec } from "../contract.ts";

const MAX_READ_BYTES = 1_000_000; // ~1MB; bigger files should be grepped, not fully read into context

export function createReadTool(deps: ToolDeps): ToolSpec {
  const spec: ToolSpec<{ path: string }> = {
    name: "read",
    description: "Reads the full contents of a file at the given path.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path to the file, absolute or relative to the project root." },
      },
      required: ["path"],
    },
    riskTier: "safe",
    renderCall: (input) => `read ${input.path}`,

    async handler(input) {
      const resolved = deps.sandbox.resolvePath(input.path);
      requirePathScope(deps.identity, deps.capabilities, resolved);

      const stat = statSync(resolved);
      if (stat.size > MAX_READ_BYTES) {
        return {
          content: `file is ${stat.size} bytes, larger than the ${MAX_READ_BYTES}-byte read limit; use grep to search it instead of reading it whole`,
          isError: true,
        };
      }

      return { content: readFileSync(resolved, "utf8") };
    },
  };
  return spec as unknown as ToolSpec;
}
