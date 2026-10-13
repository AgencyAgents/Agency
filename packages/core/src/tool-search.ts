import type { ToolSpec } from "./loop.ts";

export const TOOL_SEARCH = "tool_search";
/** `auto` hides the MCP tools when there are more than this: below it, the schemas cost less than a search step. */
export const DEFER_MCP_ABOVE = 10;
const MAX_FOUND = 5;

export type DeferMode = "auto" | "always" | "never";

const words = (text: string): string[] => text.toLowerCase().match(/[a-z0-9]+/g) ?? [];

/**
 * Hides the schemas of the MCP tools until the model loads them with `tool_search`. The tool list of a request then
 * stays small with many MCP servers. `loaded` is the state of one session: a loaded tool stays in its requests.
 */
export function deferTools(tools: ToolSpec[], mode: DeferMode, loaded: Set<string>): ToolSpec[] {
  const deferred = tools.filter((tool) => (tool as { origin?: string }).origin === "mcp");
  if (mode === "never" || deferred.length === 0) return tools;
  if (mode === "auto" && deferred.length <= DEFER_MCP_ABOVE) return tools;
  const names = new Set(deferred.map((tool) => tool.name));
  const search: ToolSpec = {
    name: TOOL_SEARCH,
    description:
      "Loads tools that are not in your tool list yet. After a load you can call them. " +
      "Give keywords for what you need, or the exact names. " +
      `The tools that you can load: ${[...names].join(", ")}`,
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
      for (const tool of found) loaded.add(tool.name);
      return {
        content: `Loaded. You can call these tools now:\n${found.map((tool) => `- ${tool.name}: ${tool.description}`).join("\n")}`,
      };
    },
  };
  return [
    ...tools.map((tool) => (names.has(tool.name) ? { ...tool, hidden: () => !loaded.has(tool.name) } : tool)),
    search,
  ];
}
