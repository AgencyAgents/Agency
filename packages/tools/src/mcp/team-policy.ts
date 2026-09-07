import type { ToolSpec } from "../contract.ts";
import { ProcessManager } from "../process-manager.ts";
import type { McpServerConfig, McpServersConfig } from "./config.ts";
import { type McpManager, type McpManagerOptions, startMcpServers } from "./manager.ts";

/** Upper bound on shared server processes per team, surfaced in cost_report. */
export const TEAM_MCP_PROCESS_CAP = 8;

// Read-only or stateless servers start once per team and are
// shared; anything stateful stays per-agent for isolation.
export function classifyTeamServer(config: McpServerConfig): "shared" | "dedicated" {
  return config.readOnly === true || config.stateless === true ? "shared" : "dedicated";
}

export function splitTeamServers(servers: McpServersConfig): {
  shared: McpServersConfig;
  dedicated: McpServersConfig;
} {
  const shared: McpServersConfig = {};
  const dedicated: McpServersConfig = {};
  for (const [name, config] of Object.entries(servers)) {
    (classifyTeamServer(config) === "shared" ? shared : dedicated)[name] = config;
  }
  return { shared, dedicated };
}

export interface TeamMcpUsage {
  sharedServers: number;
  sharedProcesses: number;
  cap: number;
}

// One pool per team: shared servers start once, every member scope
// registers the same adapted specs instead of new processes.
export class TeamMcpPool {
  private manager?: McpManager;
  private readonly processes = new ProcessManager();
  private readonly names: string[];

  constructor(
    readonly teamId: string,
    private readonly servers: McpServersConfig,
    private readonly options: Omit<McpManagerOptions, "servers">,
  ) {
    this.names = Object.keys(servers).slice(0, TEAM_MCP_PROCESS_CAP);
  }

  static split(raw: unknown): { shared: McpServersConfig; dedicated: McpServersConfig } {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { shared: {}, dedicated: {} };
    return splitTeamServers(raw as McpServersConfig);
  }

  async start(): Promise<void> {
    if (this.manager || this.names.length === 0) return;
    const subset: McpServersConfig = {};
    for (const name of this.names) {
      const config = this.servers[name];
      if (config) subset[name] = config;
    }
    // Pool-owned processes: shared servers live as long as the team,
    // never tied to one member scope's dispose.
    this.manager = await startMcpServers({
      processManager: this.processes,
      ...this.options,
      servers: subset,
    });
  }

  sharedTools(): ToolSpec[] {
    return this.manager?.tools ?? [];
  }

  failures(): ReadonlyMap<string, string> {
    return this.manager?.failures ?? new Map();
  }

  usage(): TeamMcpUsage {
    return {
      sharedServers: this.names.length,
      sharedProcesses: this.names.length,
      cap: TEAM_MCP_PROCESS_CAP,
    };
  }

  async dispose(): Promise<void> {
    await this.manager?.dispose();
    this.manager = undefined;
    this.processes.killAll();
  }
}
