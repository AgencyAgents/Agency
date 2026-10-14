import type { ToolSpec } from "./loop.ts";

export const TOOL_SEARCH = "tool_search";
export const CALL_TOOL = "call_tool";
/** `auto` hides the MCP tools when there are more than this: below it, the schemas cost less than a search step. */
export const DEFER_MCP_ABOVE = 10;
const MAX_FOUND = 5;

export type DeferMode = "auto" | "always" | "never";

const words = (text: string): string[] => text.toLowerCase().match(/[a-z0-9]+/g) ?? [];

/**
 * Keeps the schemas of the MCP tools out of the requests. The model finds a tool with `tool_search`, which gives the
 * schema as text, and calls it with `call_tool`. The tool list of a request never changes, so the prompt cache of the
 * provider holds.
 */
export function deferTools(tools: ToolSpec[], mode: DeferMode): ToolSpec[] {
  const deferred = tools.filter((tool) => (tool as { origin?: string }).origin === "mcp");
  if (mode === "never" || deferred.length === 0) return tools;
  if (mode === "auto" && deferred.length <= DEFER_MCP_ABOVE) return tools;
  const names = new Set(deferred.map((tool) => tool.name));
  const search: ToolSpec = {
    name: TOOL_SEARCH,
    description:
      `Finds tools that are not in your tool list and gives their input schema. Call a found tool with ${CALL_TOOL}. ` +
      "Give keywords for what you need, or the exact names. " +
      `The tools that you can find: ${[...names].join(", ")}`,
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Keywords, or tool names with commas between them." },
      },
      required: ["query"],
    },
    riskTier: "safe",
    handler: async (input) => {
      const query = String(input.query ?? "");
      const exact = query
        .split(",")
        .map((name) => name.trim())
        .filter((name) => names.has(name));
      const wanted = new Set(words(query));
      const scored = deferred
        .map((tool) => ({
          tool,
          score: words(`${tool.name} ${tool.description}`).filter((word) => wanted.has(word)).length,
        }))
        .filter((entry) => entry.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, MAX_FOUND)
        .map((entry) => entry.tool);
      const found = exact.length > 0 ? deferred.filter((tool) => exact.includes(tool.name)) : scored;
      if (found.length === 0) {
        return {
          content: `no tool matches "${query}". Use words from the names in the description.`,
          isError: true,
        };
      }
      const lines = found.map(
        (tool) => `- ${tool.name}: ${tool.description}\n  input schema: ${JSON.stringify(tool.inputSchema)}`,
      );
      return {
        content: `Found. Call one with ${CALL_TOOL}: {"name": "<tool name>", "input": {...}}\n${lines.join("\n")}`,
      };
    },
  };
  const call: ToolSpec = {
    name: CALL_TOOL,
    description: `Calls a tool that ${TOOL_SEARCH} found. \`input\` is the input object of that tool, after its schema.`,
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "The exact name of the tool." },
        input: { type: "object", description: "The input of the tool." },
      },
      required: ["name"],
    },
    // The permission rules judge the tool that it calls, under the name of that tool.
    riskTier: "safe",
    handler: async (input, ctx) => {
      const name = String(input.name ?? "");
      if (!names.has(name)) {
        return {
          content: `"${name}" is not a tool of ${TOOL_SEARCH}. Call a tool of your tool list directly.`,
          isError: true,
        };
      }
      if (!ctx.callTool) return { content: `${CALL_TOOL} is not available in this run`, isError: true };
      const inner = input.input;
      const object = inner !== null && typeof inner === "object" && !Array.isArray(inner);
      return ctx.callTool(name, object ? (inner as Record<string, unknown>) : {});
    },
  };
  return [
    ...tools.map((tool) => (names.has(tool.name) ? { ...tool, hidden: () => true } : tool)),
    search,
    call,
  ];
}
