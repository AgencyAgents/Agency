import type { ApprovalRequest, ApprovalResponse } from "@agency/guard";
import type { ToolSpec } from "../loop.ts";

export interface DispatchInput {
  agents: Array<{ handle: string; brief: string; effort?: string }>;
}

export interface DispatchCtx {
  signal: AbortSignal;
  /**
   * Depth of the calling turn. The daemon spawns each child at
   * `taskDepth + 1` (passed as `taskDepth` to `runTurn`), so nesting is
   * bounded by `maxDepth` no matter how many levels dispatch recurses.
   */
  taskDepth: number;
  /**
   * Ask the user to approve a costly dispatch before spawning peers.
   * Absent when the caller has no approval surface (fail-closed).
   */
  requestApproval?: (request: ApprovalRequest) => Promise<ApprovalResponse>;
}

function summarizeOneLine(text: string, max = 120): string {
  const line = text.split("\n")[0]?.trim() ?? "";
  return line.length > max ? `${line.slice(0, max)}…` : line;
}

export function createDispatchTool(deps: {
  dispatch: (input: DispatchInput, ctx: DispatchCtx) => Promise<{ content: string; isError?: boolean }>;
  maxDepth?: number;
}): ToolSpec {
  const maxDepth = deps.maxDepth ?? 3;
  return {
    name: "dispatch",
    description: "Dispatch peer agents by handle with a brief; effort override for auto agents.",
    // Moderate, not safe: dispatch spawns real subagent turns. The gate
    // allows orchestration tools by default in trusted workspaces.
    riskTier: "moderate",
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
      const first = lines.at(0);
      if (!first) return "dispatch: no agents";
      if (lines.length === 1) return `◐ ${summarizeOneLine(first)}`;
      const preview = lines
        .slice(0, 2)
        .map((l) => summarizeOneLine(l, 80))
        .join(" · ");
      return `dispatch ${lines.length} agents · ${preview}${lines.length > 2 ? " · …" : ""}`;
    },
    async handler(input: unknown, ctx: unknown) {
      const toolCtx = ctx as {
        taskDepth?: number;
        signal?: AbortSignal;
        requestApproval?: (request: ApprovalRequest) => Promise<ApprovalResponse>;
      };
      const depth = toolCtx.taskDepth ?? 0;
      // Depth-0 child isolation: subagents (taskDepth > 0) cannot dispatch.
      if (depth > 0) {
        return { content: "nested dispatch blocked: subagents cannot dispatch", isError: true };
      }
      if (depth >= maxDepth) {
        return { content: `dispatch depth limit reached (${depth} >= ${maxDepth})`, isError: true };
      }
      const agents = (input as DispatchInput)?.agents;
      if (!Array.isArray(agents) || agents.length === 0) {
        return { content: "dispatch: no agents to dispatch", isError: true };
      }
      for (const a of agents) {
        if (
          typeof a?.handle !== "string" ||
          a.handle.length === 0 ||
          typeof a?.brief !== "string" ||
          a.brief.length === 0
        ) {
          return { content: "dispatch: each agent requires a non-empty handle and brief", isError: true };
        }
      }
      // Depth passes through unchanged here: the daemon spawns each child
      // turn at taskDepth + 1, so the increment happens exactly once per level.
      return deps.dispatch(input as DispatchInput, {
        signal: toolCtx.signal ?? new AbortController().signal,
        taskDepth: depth,
        requestApproval: toolCtx.requestApproval,
      });
    },
  } as unknown as ToolSpec;
}
