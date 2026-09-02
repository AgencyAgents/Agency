import { readFileSync, writeFileSync } from "node:fs";
import { requirePathScope } from "@agency/guard";
import { AgencyError, ErrorCode } from "@agency/schema";
import type { ToolDeps, ToolSpec } from "../contract.ts";
import { applyEdit } from "../edit-engine.ts";
import type { FormatterConfig } from "../formatter.ts";
import { runFormatter } from "../formatter.ts";
import { str, summarize } from "../render.ts";
import type { SnapshotStore } from "../snapshot.ts";

export function createEditTool(
  deps: ToolDeps,
  snapshots: SnapshotStore,
  formatter: FormatterConfig,
): ToolSpec {
  const spec: ToolSpec<{ path: string; oldText: string; newText: string; replaceAll?: boolean }> = {
    name: "edit",
    description:
      "Replaces an exact block of text in a file with new text. oldText must match the file's current " +
      "content exactly and uniquely (include enough surrounding context), or the edit is rejected.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        oldText: { type: "string" },
        newText: { type: "string" },
        replaceAll: { type: "boolean" },
      },
      required: ["path", "oldText", "newText"],
    },
    riskTier: "moderate",
    renderCall: (input) => `edit ${str(input.path)}`,
    renderResult: (result) =>
      result.isError ? `edit failed: ${summarize(result.content)}` : summarize(result.content),

    async handler(input, ctx) {
      const resolved = deps.sandbox.resolvePath(input.path);
      requirePathScope(deps.identity, deps.capabilities, resolved);

      let current: string;
      try {
        current = readFileSync(resolved, "utf8");
      } catch {
        return {
          content: `cannot edit ${input.path}: it doesn't exist yet, use write instead`,
          isError: true,
        };
      }

      try {
        const updated = applyEdit(current, input);
        snapshots.capture(resolved, current, ctx.turnId);
        writeFileSync(resolved, updated, "utf8");
        await runFormatter(formatter, resolved);
        snapshots.recordAfter(resolved);
        return { content: `edited ${input.path}` };
      } catch (error) {
        if (error instanceof AgencyError && error.code === ErrorCode.TOOL_ERROR) {
          return { content: error.message, isError: true };
        }
        throw error;
      }
    },
  };
  return spec as unknown as ToolSpec;
}
