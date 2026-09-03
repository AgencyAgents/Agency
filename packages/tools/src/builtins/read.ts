import { readFileSync, statSync } from "node:fs";
import { requirePathScope } from "@agency/guard";
import { t } from "@agency/i18n";
import type { ImageBlock } from "@agency/schema";
import type { ToolDeps, ToolSpec } from "../contract.ts";
import { lineCount, str, summarize } from "../render.ts";
import type { ReadState } from "../read-state.ts";

const MAX_READ_BYTES = 1_000_000; // ~1MB; bigger files should be grepped or read in slices

/** Image formats every vision-capable provider we ship accepts (P7 image input). */
export const IMAGE_MIME_BY_EXTENSION: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
};

export function imageMimeFor(path: string): string | undefined {
  const dot = path.lastIndexOf(".");
  if (dot === -1) return undefined;
  return IMAGE_MIME_BY_EXTENSION[path.slice(dot).toLowerCase()];
}

export interface ReadToolOptions {
  /** Session read journal; marks files so write can warn on unread overwrites. */
  readState?: ReadState;
}

function positiveIntOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 ? value : fallback;
}

function limitOrAll(input: unknown): number | undefined {
  return typeof input === "number" && Number.isInteger(input) && input >= 1 ? input : undefined;
}

function numberedSlice(content: string, offset: number, limit: number | undefined): string {
  const lines = content.split("\n");
  const selected = lines.slice(offset - 1, limit === undefined ? undefined : offset - 1 + limit);
  const numbered: string[] = [];
  let used = 0;
  for (const [index, line] of selected.entries()) {
    const rendered = `${String(offset + index).padStart(6)}  ${line}`;
    const bytes = Buffer.byteLength(rendered, "utf8");
    if (used + bytes > MAX_READ_BYTES) break;
    used += bytes;
    numbered.push(rendered);
  }
  const truncated = used < Buffer.byteLength(selected.join("\n"), "utf8");
  const suffix = truncated ? `\n${t("tool.read.slice_truncated", { bytes: MAX_READ_BYTES })}` : "";
  return numbered.join("\n") + suffix;
}

export function createReadTool(deps: ToolDeps, options?: ReadToolOptions): ToolSpec {
  const spec: ToolSpec<{ path: string; offset?: number; limit?: number }> = {
    name: "read",
    description:
      "Reads the contents of a file at the given path. Files over 1MB must be read in slices: " +
      "pass offset (1-based line to start from) and limit (lines per read); sliced output carries " +
      "line numbers so edits can anchor on them.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path to the file, absolute or relative to the project root." },
        offset: { type: "integer", description: "1-based line to start reading from. Default 1." },
        limit: { type: "integer", description: "Maximum number of lines to return. Default: all." },
      },
      required: ["path"],
    },
    riskTier: "safe",
    renderCall: (input) => `read ${str(input.path)}`,
    renderResult: (result) => {
      const path = str(result.input?.path);
      const label = path ? `read ${path}` : "read";
      if (result.isError) return `${label} failed: ${summarize(result.content)}`;
      return `${label}: ${lineCount(result.content)} lines`;
    },

    async handler(input, ctx) {
      const resolved = await deps.sandbox.resolvePathGated(input.path, {
        tool: "read",
        ask: ctx.requestApproval,
      });
      requirePathScope(deps.identity, deps.capabilities, resolved);
      options?.readState?.mark(resolved);

      const stat = statSync(resolved);
      const offset = positiveIntOr(input.offset, 1);
      const limit = limitOrAll(input.limit);
      const slicing = offset !== 1 || limit !== undefined;

      if (stat.size > MAX_READ_BYTES && !slicing) {
        return {
          content: t("tool.read.too_large", { bytes: stat.size, limit: MAX_READ_BYTES }),
          isError: true,
        };
      }

      const mime = imageMimeFor(resolved);
      if (mime) {
        const image: ImageBlock = {
          type: "image",
          mimeType: mime,
          data: readFileSync(resolved).toString("base64"),
        };
        return {
          content: t("image.read.attached", { path: input.path, mime, bytes: stat.size }),
          images: [image],
        };
      }

      const content = readFileSync(resolved, "utf8");
      if (!slicing) return { content };
      return { content: numberedSlice(content, offset, limit) };
    },
  };
  return spec as unknown as ToolSpec;
}
