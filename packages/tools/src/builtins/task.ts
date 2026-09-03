import type { ToolSpec, ToolContext } from "../contract.ts";
import { summarize } from "../render.ts";

export interface TaskToolDeps {
  maxDepth?: number;
  runTask: (
    input: { prompt: string; tools?: string[]; model?: string },
    ctx: ToolContext,
  ) => Promise<{ content: string; isError?: boolean }>;
}

export function createTaskTool(deps: TaskToolDeps): ToolSpec {
  const maxDepth = deps.maxDepth ?? 1;
  const spec: ToolSpec<{ prompt: string; tools?: string[]; model?: string }> = {
    name: "task",
    description:
      "Spawns an ephemeral worker child session with isolated context. The prompt is the task. Optionally restrict tools via allowlist; model may be overridden. Returns only the worker's final text.",
    inputSchema: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "Task prompt for the worker" },
        tools: {
          type: "array",
          items: { type: "string" },
          description: "Allowlist subset of tools for the worker",
        },
        model: { type: "string", description: "Model override for the worker" },
      },
      required: ["prompt"],
    },
    riskTier: "safe",
    renderCall: (input) => `task ${summarize(input.prompt.slice(0, 80))}`,
    renderResult: (result) =>
      result.isError ? `task failed: ${summarize(result.content)}` : summarize(result.content),
    async handler(input, ctx) {
      const depth = ctx.taskDepth ?? 0;
      if (depth >= maxDepth) {
        return {
          content: `task depth limit reached (depth ${depth} >= maxDepth ${maxDepth}): nested task denied`,
          isError: true,
        };
      }
      if (typeof input.prompt !== "string" || input.prompt.trim().length === 0) {
        return { content: "task requires a non-empty prompt", isError: true };
      }
      return deps.runTask(input, ctx);
    },
  };
  return spec as unknown as ToolSpec;
}

export function extractFinalText(messages: Array<{ role: string; content: Array<{ type: string; text?: string; content?: string }> }>): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg?.role !== "assistant") continue;
    const texts: string[] = [];
    for (const block of msg.content ?? []) {
      if (block.type === "text" && typeof block.text === "string" && block.text.trim().length > 0) {
        texts.push(block.text);
      }
    }
    if (texts.length > 0) return texts.join("\n");
  }
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg?.role !== "assistant") continue;
    for (const block of msg.content ?? []) {
      if (block.type === "tool_result" && typeof block.content === "string") return block.content;
    }
  }
  return "";
}
