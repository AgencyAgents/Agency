import { readFileSync, statSync } from "node:fs";
import { requirePathScope } from "@agency/guard";
import { t } from "@agency/i18n";
import type { ImageBlock } from "@agency/schema";
import type { ToolDeps, ToolSpec } from "../contract.ts";
import { lineCount, str, summarize } from "../render.ts";

const MAX_READ_BYTES = 1_000_000; // ~1MB; bigger files should be grepped, not fully read into context

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

      const stat = statSync(resolved);
      if (stat.size > MAX_READ_BYTES) {
        return {
          content: `file is ${stat.size} bytes, larger than the ${MAX_READ_BYTES}-byte read limit; use grep to search it instead of reading it whole`,
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

      return { content: readFileSync(resolved, "utf8") };
    },
  };
  return spec as unknown as ToolSpec;
}
