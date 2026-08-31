import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { requirePathScope } from "@agency/guard";
import type { ToolDeps, ToolSpec } from "../contract.ts";
import type { FormatterConfig } from "../formatter.ts";
import { runFormatter } from "../formatter.ts";
import type { SnapshotStore } from "../snapshot.ts";

export function createWriteTool(
  deps: ToolDeps,
  snapshots: SnapshotStore,
  formatter: FormatterConfig,
): ToolSpec {
  const spec: ToolSpec<{ path: string; content: string }> = {
    name: "write",
    description: "Creates a file with the given content, or fully overwrites it if it already exists.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        content: { type: "string" },
      },
      required: ["path", "content"],
    },
    riskTier: "moderate",
    renderCall: (input) => `write ${input.path}`,

    async handler(input) {
      const resolved = deps.sandbox.resolvePath(input.path);
      requirePathScope(deps.identity, deps.capabilities, resolved);

      if (existsSync(resolved)) {
        snapshots.capture(resolved, readFileSync(resolved, "utf8"));
      } else {
        mkdirSync(dirname(resolved), { recursive: true });
      }

      writeFileSync(resolved, input.content, "utf8");
      await runFormatter(formatter, resolved);

      return { content: `wrote ${input.content.length} bytes to ${input.path}` };
    },
  };
  return spec as unknown as ToolSpec;
}
