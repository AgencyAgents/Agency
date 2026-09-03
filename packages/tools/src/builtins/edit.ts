import { readFileSync, writeFileSync } from "node:fs";
import { requirePathScope } from "@agency/guard";
import { t } from "@agency/i18n";
import { AgencyError, ErrorCode } from "@agency/schema";
import type { ToolDeps, ToolSpec } from "../contract.ts";
import { applyEditsVerified, type EditHunk } from "../edit-engine.ts";
import type { FormatterConfig } from "../formatter.ts";
import { runFormatter } from "../formatter.ts";
import { str, summarize } from "../render.ts";
import type { ReadState } from "../read-state.ts";
import type { SnapshotStore } from "../snapshot.ts";

export interface EditToolOptions {
  /** LSP diagnostics seam: error-severity diagnostics ride along on results. */
  diagnostics?: (path: string) => readonly { severity: number; message: string; line: number; character: number }[];
  /** Session read journal; marks edited files as read. */
  readState?: ReadState;
}

interface EditInput {
  path: string;
  oldText?: string;
  newText?: string;
  hunks?: EditHunk[];
  replaceAll?: boolean;
}

function hasHunks(input: EditInput): boolean {
  return Array.isArray(input.hunks) && input.hunks.length > 0;
}

function hasPair(input: EditInput): boolean {
  return typeof input.oldText === "string" && typeof input.newText === "string";
}

function hunksFor(input: EditInput): EditHunk[] {
  if (hasHunks(input)) {
    return (input.hunks ?? []).map((hunk) => ({
      oldText: typeof hunk?.oldText === "string" ? hunk.oldText : "",
      newText: typeof hunk?.newText === "string" ? hunk.newText : "",
      ...(typeof hunk?.replaceAll === "boolean" ? { replaceAll: hunk.replaceAll } : {}),
    }));
  }
  return [
    {
      oldText: typeof input.oldText === "string" ? input.oldText : "",
      newText: typeof input.newText === "string" ? input.newText : "",
      ...(input.replaceAll ? { replaceAll: true } : {}),
    },
  ];
}

export function createEditTool(
  deps: ToolDeps,
  snapshots: SnapshotStore,
  formatter: FormatterConfig,
  options?: EditToolOptions,
): ToolSpec {
  const spec: ToolSpec<EditInput> = {
    name: "edit",
    description:
      "Replaces exact blocks of text in a file with new text. Pass oldText+newText for one hunk, or " +
      "hunks: [{oldText, newText, replaceAll?}] to apply several in one call (all-or-nothing: a hunk " +
      "that fails to match rejects the whole call and writes nothing). Each oldText must match the " +
      "file's current content uniquely (include enough surrounding context); whitespace-only drift is " +
      "tolerated. Error diagnostics from language servers ride along on the result.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        oldText: { type: "string" },
        newText: { type: "string" },
        replaceAll: { type: "boolean" },
        hunks: {
          type: "array",
          description: "Multiple search/replace hunks applied in order in one call.",
          items: {
            type: "object",
            properties: {
              oldText: { type: "string" },
              newText: { type: "string" },
              replaceAll: { type: "boolean" },
            },
            required: ["oldText", "newText"],
          },
        },
      },
      required: ["path"],
    },
    riskTier: "moderate",
    renderCall: (input) => `edit ${str(input.path)}`,
    renderResult: (result) =>
      result.isError ? `edit failed: ${summarize(result.content)}` : summarize(result.content),

    async handler(input, ctx) {
      const resolved = await deps.sandbox.resolvePathGated(input.path, {
        tool: "edit",
        ask: ctx.requestApproval,
      });
      requirePathScope(deps.identity, deps.capabilities, resolved);

      if (hasHunks(input) === hasPair(input)) {
        return { content: t("tool.edit.bad_input"), isError: true };
      }

      let current: string;
      try {
        current = readFileSync(resolved, "utf8");
      } catch {
        return {
          content: t("tool.edit.missing_file", { path: input.path }),
          isError: true,
        };
      }

      const hunks = hunksFor(input);
      for (const [index, hunk] of hunks.entries()) {
        if (hunk.oldText.length === 0) {
          return { content: t("tool.edit.empty_hunk", { index: index + 1 }), isError: true };
        }
      }

      try {
        const outcome = applyEditsVerified(current, hunks, {
          path: resolved,
          diagnostics: options?.diagnostics,
        });
        snapshots.capture(resolved, current, ctx.turnId);
        writeFileSync(resolved, outcome.content, "utf8");
        await runFormatter(formatter, resolved);
        snapshots.recordAfter(resolved);
        let content = t("tool.edit.applied", { path: input.path });
        if (hunks.length > 1) content += `\n${t("tool.edit.hunks_applied", { count: hunks.length })}`;
        if (outcome.warnings.length > 0) {
          content += `\n${t("lsp.diagnostics.warning", {
            count: outcome.warnings.length,
            path: input.path,
            summary: outcome.warnings.join("; "),
          })}`;
        }
        return { content };
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
