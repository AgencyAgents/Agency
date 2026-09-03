import type { ToolSpec } from "../loop.ts";

export interface DispatchInput {
  agents: Array<{ handle: string; brief: string; effort?: string }>;
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
    async handler(input: unknown, ctx: unknown) {
      const depth = (ctx as { taskDepth?: number }).taskDepth ?? 0;
      if (depth >= maxDepth) {
        return { content: `dispatch depth limit reached (${depth} >= ${maxDepth})`, isError: true };
      }
      return deps.dispatch(input as DispatchInput);
    },
  } as unknown as ToolSpec;
}
