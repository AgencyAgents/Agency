import type { ToolSpec } from "../loop.ts";

export interface DispatchInput {
  agents: Array<{ handle: string; brief: string; effort?: string }>;
}

function summarizeOneLine(text: string, max = 120): string {
  const line = text.split("\n")[0]?.trim() ?? "";
  return line.length > max ? `${line.slice(0, max)}…` : line;
}

export function createDispatchTool(deps: {
  dispatch: (input: DispatchInput) => Promise<{ content: string; isError?: boolean }>;
  maxDepth?: number;
}): ToolSpec {
  const maxDepth = deps.maxDepth ?? 3;
  return {
    name: "dispatch",
    description: "Dispatch peer agents by handle with a brief; effort override for auto agents.",
    inputSchema: {
      type: "object",
      properties: {
        agents: {
          type: "array",
          items: {
            type: "object",
            properties: {
              handle: { type: "string" },
              brief: { type: "string" },
              effort: { type: "string", enum: ["off", "minimal", "low", "medium", "high", "xhigh", "max"] },
            },
            required: ["handle", "brief"],
          },
        },
      },
      required: ["agents"],
    },
    renderCall: (input: unknown) => {
      const agents = (input as DispatchInput)?.agents ?? [];
      if (agents.length === 0) return "dispatch";
      const handles = agents.map((a) => a.handle).join(", ");
      return `⇉ dispatch ${handles}`;
    },
    renderResult: (result: { content: string; isError?: boolean; input?: Record<string, unknown> }) => {
      if (result.isError) return `dispatch failed: ${summarizeOneLine(result.content)}`;
      const lines = result.content
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean);
      if (lines.length === 0) return "dispatch: no agents";
      if (lines.length === 1) return `◐ ${summarizeOneLine(lines[0]!)}`;
      const preview = lines.slice(0, 2).map((l) => summarizeOneLine(l, 80)).join(" · ");
      return `dispatch ${lines.length} agents · ${preview}${lines.length > 2 ? " · …" : ""}`;
    },
    async handler(input: unknown, ctx: unknown) {
      const depth = (ctx as { taskDepth?: number }).taskDepth ?? 0;
      if (depth >= maxDepth) {
        return { content: `dispatch depth limit reached (${depth} >= ${maxDepth})`, isError: true };
      }
      return deps.dispatch(input as DispatchInput);
    },
  } as unknown as ToolSpec;
}
