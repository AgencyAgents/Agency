import type { CallerIdentity, Capabilities } from "@agency/guard";
import type { ToolSpec } from "../contract.ts";
import type { McpClient } from "./client.ts";

export interface McpToolDefinition {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

export interface AdaptOptions {
  serverName: string;
  riskTier: "safe" | "moderate" | "dangerous";
  /** Resolves the caller identity per call from the acting agent's handle. */
  identityFor: (handle?: string) => CallerIdentity;
  capabilities: Capabilities;
}

/**
 * Renders an MCP `CallToolResult.content` array into the plain text the tool
 * contract expects. MCP returns typed content blocks — `{type: "text", text}`,
 * `{type: "resource", resource: {text}}`, images, and whatever a server
 * invents next — so text is extracted where it lives and everything else is
 * JSON-stringified, never collapsed into "[object Object]" by String().
 */
export function renderMcpContent(content: unknown): string {
  if (content === undefined || content === null) return "";
  const blocks = Array.isArray(content) ? content : [content];
  return blocks.map(renderContentBlock).join("\n");
}

function renderContentBlock(block: unknown): string {
  if (typeof block === "string") return block;
  if (block === null || typeof block !== "object") return String(block);
  const record = block as Record<string, unknown>;
  if (record.type === "text" && typeof record.text === "string") return record.text;
  if (record.type === "resource") {
    const resource = record.resource;
    if (resource !== null && typeof resource === "object") {
      const text = (resource as Record<string, unknown>).text;
      if (typeof text === "string") return text;
    }
  }
  return JSON.stringify(block);
}

/** Adapts an MCP tool definition into a ToolSpec (R3). */
export function adaptMcpTool(client: McpClient, def: McpToolDefinition, options: AdaptOptions): ToolSpec {
  const spec: ToolSpec<Record<string, unknown>> = {
    name: `${options.serverName}_${def.name}`,
    description: def.description ?? `MCP tool ${def.name} from ${options.serverName}`,
    inputSchema: def.inputSchema ?? { type: "object", properties: {} },
    riskTier: options.riskTier,
    renderCall: (input) => `${options.serverName}.${def.name} ${JSON.stringify(input)}`,
    renderResult: (result) => result.content,
    async handler(input, ctx) {
      const caller = options.identityFor(ctx.agentHandle);
      const result = await client.callTool(def.name, input, ctx.signal, { identity: caller });
      return { content: renderMcpContent(result.content), isError: Boolean(result.isError) };
    },
  };
  return spec as unknown as ToolSpec;
}
