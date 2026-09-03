import type { CallerIdentity, Capabilities } from "@agency/guard";
import type { ToolSpec } from "../contract.ts";
import type { ProcessManager } from "../process-manager.ts";
import type { ToolRegistry } from "../registry.ts";
import { adaptMcpTool, type McpToolDefinition } from "./adapt.ts";
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
  registry?: ToolRegistry;
  maxRestarts?: number;
  baseBackoffMs?: number;
}

export interface McpManager {
  tools: ToolSpec[];
  failures: ReadonlyMap<string, string>;
  dispose(): Promise<void>;
}

export async function startMcpServers(options: McpManagerOptions): Promise<McpManager> {
  const failures = new Map<string, string>();
  const clients = new Map<string, McpClient>();
  const transports = new Map<string, McpTransport>();
  const tools: ToolSpec[] = [];
  const serverTools = new Map<string, Set<string>>();
  const serverDefs = new Map<string, McpToolDefinition[]>();
  const retryCounts = new Map<string, number>();
  const identityFor = options.identityFor ?? mcpIdentityFor;
  const registry = options.registry;
  const maxRestarts = options.maxRestarts ?? 3;
  const baseBackoffMs = options.baseBackoffMs ?? 500;
  let disposed = false;

  const stderrTailFor = (transport: McpTransport | undefined): string => {
    try {
      const tail = transport?.stderrTail?.() ?? "";
      return tail.trim();
    } catch {
      return "";
    }
  };

  const failureDetail = (error: unknown, transport?: McpTransport): string => {
    const base = error instanceof Error ? error.message : String(error);
    const tail = stderrTailFor(transport);
    if (!tail) return base;
    return `${base} — stderr: ${tail.slice(-2000)}`;
  };

  const removeToolsFor = (serverName: string) => {
    const names = serverTools.get(serverName);
    if (!names) return;
    for (const n of names) {
      if (registry) registry.unregister(n);
      const idx = tools.findIndex((t) => t.name === n);
      if (idx !== -1) tools.splice(idx, 1);
    }
    serverTools.delete(serverName);
    serverDefs.delete(serverName);
  };

  const addToolsFor = (
    serverName: string,
    config: McpServerConfig,
    client: McpClient,
    defs: McpToolDefinition[],
  ) => {
    const names = new Set<string>();
    for (const def of defs) {
      const spec = adaptMcpTool(client, def, {
        serverName,
        riskTier: config.riskTier ?? "moderate",
        identity: identityFor(serverName),
        capabilities: options.capabilities,
      });
      const registeredName = spec.name;
      names.add(registeredName);
      if (registry) {
        try {
          registry.register(spec);
        } catch {
          // duplicate — skip, already registered
        }
      }
      if (!tools.some((t) => t.name === registeredName)) tools.push(spec);
    }
    serverTools.set(serverName, names);
    serverDefs.set(serverName, defs);
  };

  const refreshTools = async (serverName: string, config: McpServerConfig, client: McpClient) => {
    try {
      const defs = await client.listTools();
      const oldNames = serverTools.get(serverName) ?? new Set<string>();
      const newSpecs = new Map<string, McpToolDefinition>();
      for (const d of defs) newSpecs.set(`${serverName}_${d.name}`, d);
      const newNames = new Set(newSpecs.keys());

      // Remove disappeared
      for (const old of oldNames) {
        if (!newNames.has(old)) {
          if (registry) registry.unregister(old);
          const idx = tools.findIndex((t) => t.name === old);
          if (idx !== -1) tools.splice(idx, 1);
        }
      }
      // Add new
      for (const [fullName, def] of newSpecs) {
        if (!oldNames.has(fullName)) {
          const spec = adaptMcpTool(client, def, {
            serverName,
            riskTier: config.riskTier ?? "moderate",
            identity: identityFor(serverName),
            capabilities: options.capabilities,
          });
          if (registry) {
            try {
              registry.register(spec);
            } catch {}
          }
          if (!tools.some((t) => t.name === fullName)) tools.push(spec);
        }
      }
      serverTools.set(serverName, newNames);
      serverDefs.set(serverName, defs);
      failures.delete(serverName);
    } catch (error) {
      failures.set(serverName, failureDetail(error, transports.get(serverName)));
    }
  };

  const scheduleRestart = (serverName: string, config: McpServerConfig) => {
    if (disposed) return;
    const count = retryCounts.get(serverName) ?? 0;
    if (count >= maxRestarts) return;
    retryCounts.set(serverName, count + 1);
    const delay = baseBackoffMs * Math.pow(2, count);
    setTimeout(() => {
      if (disposed) return;
      void startOne(serverName, config);
    }, delay);
  };

  const startOne = async (name: string, config: McpServerConfig): Promise<void> => {
    let transport: McpTransport | undefined;
    let client: McpClient | undefined;
    try {
      transport = options.transportFor
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
      transports.set(name, transport);
      const timeoutMs = config.requestTimeoutMs ?? config.timeoutMs;
      const toolTimeoutMs = config.toolCallTimeoutMs ?? config.timeoutMs;
      client = new McpClient(name, transport, {
        ...(timeoutMs !== undefined ? { requestTimeoutMs: timeoutMs } : {}),
        ...(toolTimeoutMs !== undefined ? { toolCallTimeoutMs: toolTimeoutMs } : {}),
      });
      clients.set(name, client);

      client.onListChanged(() => {
        void refreshTools(name, config, client!);
      });
      transport.onClose?.(() => {
        if (disposed) return;
        const existing = clients.get(name);
        if (!existing) return;
        // crash path
        removeToolsFor(name);
        failures.set(name, `MCP server "${name}" crashed${stderrTailFor(transport) ? ` — stderr: ${stderrTailFor(transport).slice(-2000)}` : ""}`);
        clients.delete(name);
        transports.delete(name);
        scheduleRestart(name, config);
      });

      await transport.start();
      await client.initialize();
      const defs = await client.listTools();
      addToolsFor(name, config, client, defs);
      failures.delete(name);
      retryCounts.delete(name);
    } catch (error) {
      const detail = failureDetail(error, transport);
      failures.set(name, detail);
      if (client) {
        try {
          await client.close();
        } catch {}
        clients.delete(name);
      }
      if (transport) transports.delete(name);
      removeToolsFor(name);
      if (!disposed && transport) {
        // don't auto-restart on initial handshake failure unless it's a crash-like close;
        // handshake errors are start failures, not runtime crashes. Still allow bounded restart
        // if we have a transport that closed?
      }
    }
  };

  await Promise.all(Object.entries(options.servers).map(([name, config]) => startOne(name, config)));

  // Wire initial list_changed that may have fired before Promise.all resolved?
  // Already handled via onListChanged callback per client.

  return {
    tools,
    failures,
    async dispose() {
      disposed = true;
      const toClose = [...clients.values()];
      clients.clear();
      transports.clear();
      for (const client of toClose) {
        try {
          await client.close();
        } catch {}
      }
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
