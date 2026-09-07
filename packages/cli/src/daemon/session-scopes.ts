import { join } from "node:path";
import {
  type AgentRegistry,
  type BoardStore,
  type Config,
  isTeamLive,
  storagePaths,
  type ToolSpec,
} from "@agency/core";
import type { CallerIdentity, PermissionsGate, SandboxBoundary } from "@agency/guard";
import type { HttpClient } from "@agency/net";
import { createSessionScope, type SessionScope, type TeamMcpPool, type TodoPersistence } from "@agency/tools";
import {
  demoteScopeForLead,
  registerBoardToolsForScope,
  registerCoordToolsForScope,
} from "./handlers/coords.ts";
import { buildDispatchTool } from "./handlers/dispatch.ts";
import { buildSpawnTool } from "./handlers/session.ts";
import { attachTeamMcpPool, teamMcpDedicatedServers } from "./handlers/team-run.ts";
import type { TeamContext } from "./team-context.ts";
import type { AgentDaemonOptions, DaemonContext } from "./types.ts";

export interface SessionScopeFactoryDeps {
  options: AgentDaemonOptions;
  config: Config;
  http: HttpClient;
  identity: CallerIdentity;
  sandbox: SandboxBoundary;
  todoPersistence: TodoPersistence;
  teamMcpPools: Map<string, TeamMcpPool>;
  teamContexts: Map<string, TeamContext>;
  teamRegistry: AgentRegistry;
  boardStore: BoardStore;
  gate: PermissionsGate;
  gateForAgent: (handle: string) => PermissionsGate;
  sharedPluginTools: ToolSpec[];
  getCtx: () => DaemonContext;
}

export function createSessionScopes(deps: SessionScopeFactoryDeps): {
  sessionScopes: Map<string, SessionScope>;
  scopePromises: Map<string, Promise<SessionScope>>;
  getOrCreateScope: (sessionId: string, handle?: string) => Promise<SessionScope>;
} {
  const {
    options,
    config,
    http,
    identity,
    sandbox,
    todoPersistence,
    teamMcpPools,
    teamContexts,
    teamRegistry,
    boardStore,
    gate,
    gateForAgent,
    sharedPluginTools,
    getCtx,
  } = deps;
  const snapshotDir = storagePaths(options.workspaceRoot).snapshotsDir;
  const sessionScopes = new Map<string, SessionScope>();
  const scopePromises = new Map<string, Promise<SessionScope>>();
  async function getOrCreateScope(sessionId: string, handle?: string): Promise<SessionScope> {
    const existing = sessionScopes.get(sessionId);
    if (existing) return existing;
    const pending = scopePromises.get(sessionId);
    if (pending) return pending;
    const promise = (async () => {
      let teamParent: string | undefined;
      for (const team of teamContexts.values()) {
        if (team.sessions.has(sessionId)) {
          teamParent = team.parentSessionId;
          break;
        }
      }
      const scope = await createSessionScope({
        deps: { identity, capabilities: { tools: "*", pathScopes: "*", network: "*" }, sandbox },
        http,
        workspaceRoot: options.workspaceRoot,
        snapshotDir,
        snapshotJournalFile: join(snapshotDir, "journals", `${sessionId}.journal.jsonl`),
        formatter: config.formatter,
        windowsShell: config.windowsShell,
        ...(config.websearch?.endpoint ? { websearch: { endpoint: config.websearch.endpoint } } : {}),
        todoPersistence,
        mcpServers: teamMcpDedicatedServers(config.mcpServers, teamParent),
        lspServers: config.lspServers,
        identityFor: (_serverName, h) => ({ type: "agent", name: h ?? handle ?? "main" }),
      });
      await attachTeamMcpPool(teamMcpPools, config.mcpServers, scope, {
        teamParent,
        ...(handle ? { handle } : {}),
      });
      for (const t of sharedPluginTools) {
        try {
          scope.registry.register(t);
        } catch {}
      }
      try {
        const spawnTool = buildSpawnTool(getCtx(), scope);
        if (!scope.registry.has("spawn")) scope.registry.register(spawnTool);
        try {
          const cfgAgents = (config as unknown as { agents?: Record<string, unknown> }).agents;
          const hasTeam = cfgAgents && Object.keys(cfgAgents).length > 1;
          if (hasTeam && !scope.registry.has("dispatch")) {
            const dispatchTool = buildDispatchTool(getCtx(), sessionId);
            scope.registry.register(dispatchTool);
          }
        } catch {}
      } catch {}
      (scope as { tools: ToolSpec[] }).tools = scope.registry.list();
      let ownerHandle: string | undefined;
      for (const team of teamContexts.values()) {
        const meta = team.sessions.get(sessionId);
        if (meta) {
          ownerHandle = meta.handle;
          break;
        }
      }
      ownerHandle ??= teamRegistry.list().find((a) => a.sessionId === sessionId)?.handle;
      try {
        await registerBoardToolsForScope(scope, getCtx(), ownerHandle, handle);
      } catch {}
      try {
        await registerCoordToolsForScope(scope, getCtx(), ownerHandle ?? handle ?? "lead");
        (scope as { tools: ToolSpec[] }).tools = scope.registry.list();
      } catch {}
      if (ownerHandle) {
        const ownerGate = gateForAgent(ownerHandle);
        if (ownerGate !== gate) {
          (scope as { tools: ToolSpec[] }).tools = (scope as unknown as { tools: ToolSpec[] }).tools.filter(
            (t) => ownerGate.toolOffered(t.name, t.riskTier),
          );
        }
      }
      const scopeFiler = ownerHandle ?? handle ?? "lead";
      (scope as { tools: ToolSpec[] }).tools = demoteScopeForLead(
        (scope as unknown as { tools: ToolSpec[] }).tools,
        scopeFiler,
        isTeamLive(boardStore.list()),
      );
      return scope;
    })();
    scopePromises.set(sessionId, promise);
    try {
      const scope = await promise;
      sessionScopes.set(sessionId, scope);
      return scope;
    } finally {
      scopePromises.delete(sessionId);
    }
  }
  return { sessionScopes, scopePromises, getOrCreateScope };
}
