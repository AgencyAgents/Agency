import type { ToolContext, ToolSpec } from "../contract.ts";
import { summarize } from "../render.ts";

export interface SpawnToolDeps {
  maxDepth?: number;
  runTask: (
    input: { prompt: string; tools?: string[]; model?: string },
    ctx: ToolContext,
  ) => Promise<{ content: string; isError?: boolean }>;
}

export function createSpawnTool(deps: SpawnToolDeps): ToolSpec {
  const maxDepth = deps.maxDepth ?? 1;
  const spec: ToolSpec<{ prompt: string; tools?: string[]; model?: string }> = {
    name: "spawn",
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
    renderCall: (input) => `spawn ${summarize(input.prompt.slice(0, 80))}`,
    renderResult: (result) => {
      if (result.isError) return `spawn failed: ${summarize(result.content)}`;
      return `◐ spawn · ${summarize(result.content)}`;
    },
    async handler(input, ctx) {
      const depth = ctx.taskDepth ?? 0;
      if (depth > 0) {
        return {
          content: "nested spawn blocked: subagents cannot spawn workers",
          isError: true,
          reason: "nested-blocked",
        };
      }
      if (depth >= maxDepth) {
        return {
          content: `spawn depth limit reached (depth ${depth} >= maxDepth ${maxDepth}): nested spawn denied`,
          isError: true,
          reason: "depth-limit",
        };
      }
      if (typeof input.prompt !== "string" || input.prompt.trim().length === 0) {
        return { content: "spawn requires a non-empty prompt", isError: true, reason: "invalid-entry" };
      }
      return deps.runTask(input, ctx);
    },
  };
  return spec;
}

export function extractFinalText(
  messages: Array<{ role: string; content: Array<{ type: string; text?: string; content?: string }> }>,
): string {
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
