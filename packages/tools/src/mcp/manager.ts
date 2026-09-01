import type { CallerIdentity, Capabilities } from "@agency/guard";
import type { ToolSpec } from "../contract.ts";
import type { ProcessManager } from "../process-manager.ts";
import { adaptMcpTool } from "./adapt.ts";
import { McpClient } from "./client.ts";
import { type McpServerConfig, type McpServersConfig, parseMcpServers } from "./config.ts";
import { createMcpTransport, type McpTransport } from "./transport.ts";

export function mcpIdentityFor(_serverName: string): CallerIdentity {
  return { type: "agent", name: "main" };
}

export interface McpManagerOptions {
  servers: McpServersConfig;
  identityFor?: (serverName: string) => CallerIdentity;
  capabilities: Capabilities;
  processManager?: ProcessManager;
  transportFor?: (serverName: string, config: McpServerConfig) => McpTransport;
}

export interface McpManager {
  tools: ToolSpec[];
  failures: ReadonlyMap<string, string>;
  dispose(): Promise<void>;
}

export async function startMcpServers(options: McpManagerOptions): Promise<McpManager> {
  const failures = new Map<string, string>();
  const clients: McpClient[] = [];
  const tools: ToolSpec[] = [];
  const identityFor = options.identityFor ?? mcpIdentityFor;

  for (const [name, config] of Object.entries(options.servers)) {
    try {
      const transport = options.transportFor
        ? options.transportFor(name, config)
        : createMcpTransport(name, config, {
            adopt: options.processManager
              ? (proc, command) => {
                  options.processManager?.adopt(
                    proc as unknown as Parameters<NonNullable<ProcessManager["adopt"]>>[0],
                    command,
                  );
                }
              : undefined,
          });
      const client = new McpClient(name, transport);
      client.onListChanged(() => {
        failures.set(name, "tool list changed — refresh not yet implemented");
      });
      await transport.start();
      await client.initialize();
      const defs = await client.listTools();
      clients.push(client);
      for (const def of defs) {
        tools.push(
          adaptMcpTool(client, def, {
            serverName: name,
            riskTier: config.riskTier ?? "moderate",
            identity: identityFor(name),
            capabilities: options.capabilities,
          }),
        );
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      failures.set(name, detail);
    }
  }

  return {
    tools,
    failures,
    async dispose() {
      for (const client of clients) {
        try {
          await client.close();
        } catch {}
      }
      clients.length = 0;
      tools.length = 0;
    },
  };
}

export async function startMcpServersFromRaw(
  raw: unknown,
  options: Omit<McpManagerOptions, "servers">,
): Promise<McpManager> {
  let servers: McpServersConfig;
  try {
    servers = parseMcpServers(raw);
  } catch (error) {
    throw new Error(`invalid mcpServers config: ${String(error)}`);
  }
  return startMcpServers({ ...options, servers });
}
