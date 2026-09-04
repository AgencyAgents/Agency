import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { requirePathScope } from "@agency/guard";
import { t } from "@agency/i18n";
import type { ToolDeps, ToolSpec } from "../contract.ts";
import type { FormatterConfig } from "../formatter.ts";
import { runFormatter } from "../formatter.ts";
import type { ReadState } from "../read-state.ts";
import { str, summarize } from "../render.ts";
import type { SnapshotStore } from "../snapshot.ts";

export interface WriteToolOptions {
  /** Session read journal; set to warn when overwriting a file never read. */
  readState?: ReadState;
}

export function createWriteTool(
  deps: ToolDeps,
  snapshots: SnapshotStore,
  formatter: FormatterConfig,
  options?: WriteToolOptions,
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
    renderCall: (input) => `write ${str(input.path)}`,
    renderResult: (result) =>
      result.isError ? `write failed: ${summarize(result.content)}` : summarize(result.content),

    async handler(input, ctx) {
      const resolved = await deps.sandbox.resolvePathGated(input.path, {
        tool: "write",
        ask: ctx.requestApproval,
      });
      requirePathScope(deps.identity, deps.capabilities, resolved);

      const existed = existsSync(resolved);
      if (existed) {
        snapshots.capture(resolved, readFileSync(resolved, "utf8"), ctx.turnId);
      } else {
        mkdirSync(dirname(resolved), { recursive: true });
      }

      writeFileSync(resolved, input.content, "utf8");
      await runFormatter(formatter, resolved);
      snapshots.recordAfter(resolved);

      let content = t("tool.write.wrote", { bytes: input.content.length, path: input.path });
      if (existed && options?.readState && !options.readState.has(resolved)) {
        content += `\n${t("tool.write.unread_overwrite", { path: input.path })}`;
      }
      return { content };
    },
  };
  return spec as unknown as ToolSpec;
}
