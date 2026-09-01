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
  identity: CallerIdentity;
  capabilities: Capabilities;
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
      const result = await client.callTool(def.name, input, ctx.signal);
      return { content: String(result.content ?? ""), isError: Boolean(result.isError) };
    },
  };
  return spec as unknown as ToolSpec;
}
