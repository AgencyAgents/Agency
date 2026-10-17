import { createHash } from "node:crypto";
import { join } from "node:path";
import {
  type AgentRegistry,
  type BoardStore,
  type Config,
  isTeamLive,
  memoryFile,
  storagePaths,
  type ToolSpec,
} from "@agency/core";
import {
  type CallerIdentity,
  type PermissionsGate,
  type SandboxBackend,
  sandboxNetwork,
} from "@agency/guard";
import type { HttpClient } from "@agency/net";
import { GATEWAY_BASE_URLS, resolveApiKey } from "@agency/providers";
import {
  createSessionScope,
  type McpTokenStore,
  type SessionScope,
  type TeamMcpPool,
  type TodoPersistence,
  type WebSearchConfig,
} from "@agency/tools";
import {
  demoteScopeForLead,
  registerBoardToolsForScope,
  registerCoordToolsForScope,
} from "./handlers/coords.ts";
import { buildDispatchTool } from "./handlers/dispatch.ts";
import { buildSpawnTool } from "./handlers/session.ts";
import { attachTeamMcpPool, teamMcpDedicatedServers } from "./handlers/team-run.ts";
import type { TeamContext } from "./team-context.ts";
import { type AgentDaemonOptions, type DaemonContext, keySourcesFor, type RunTurnParams } from "./types.ts";

/** The search endpoint of the config, or else OpenRouter's web search when the openrouter provider has a key. */
export async function webSearchFor(config: Config, ctx: DaemonContext): Promise<WebSearchConfig | undefined> {
  if (config.websearch?.endpoint) return { endpoint: config.websearch.endpoint };
  const apiKey = async () =>
    resolveApiKey({
      provider: "openrouter",
      env: process.env,
      keychain: await ctx.getKeychain().catch(() => undefined),
      config: ctx.providers.openrouter?.apiKey,
      ...keySourcesFor("openrouter", ctx.providers),
    }).catch(() => undefined);
  if ((await apiKey()) === undefined) return undefined;
  return {
    openrouter: {
      baseUrl:
        ctx.providers.openrouter?.baseUrl ?? GATEWAY_BASE_URLS.openrouter ?? "https://openrouter.ai/api/v1",
      model: config.websearch?.model ?? "deepseek/deepseek-v4-flash",
      apiKey,
    },
  };
}

/** Git Bash (MSYS) does not start under the restricted token of the `os` backend on Windows: that backend gets PowerShell. */
export function sandboxWindowsShell(config: Config): Config["windowsShell"] {
  return config.windowsShell ?? (config.sandbox?.backend === "os" ? "powershell" : undefined);
}

export interface SessionScopeFactoryDeps {
  options: AgentDaemonOptions;
  config: Config;
  /** The servers of the config and, in a trusted workspace, those of its MCP files. */
  mcpServers: Record<string, unknown> | undefined;
  http: HttpClient;
  identity: CallerIdentity;
  sandbox: SandboxBackend;
  todoPersistence: TodoPersistence;
  teamMcpPools: Map<string, TeamMcpPool>;
  teamContexts: Map<string, TeamContext>;
  teamRegistry: AgentRegistry;
  boardStore: BoardStore;
  gate: PermissionsGate;
  gateForAgent: (handle: string) => PermissionsGate;
  sharedPluginTools: ToolSpec[];
  getCtx: () => DaemonContext;
  /** The sign-ins of `agency mcp login`. */
  mcpTokens: McpTokenStore;
}

export function createSessionScopes(deps: SessionScopeFactoryDeps): {
  sessionScopes: Map<string, SessionScope>;
  scopePromises: Map<string, Promise<SessionScope>>;
  getOrCreateScope: (sessionId: string, handle?: string, mcp?: RunTurnParams["mcp"]) => Promise<SessionScope>;
} {
  const {
    options,
    config,
    mcpServers,
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
    mcpTokens,
  } = deps;
  const snapshotDir = storagePaths(options.workspaceRoot).snapshotsDir;
  const sessionScopes = new Map<string, SessionScope>();
  const scopePromises = new Map<string, Promise<SessionScope>>();
  async function getOrCreateScope(
    sessionId: string,
    handle?: string,
    mcp?: RunTurnParams["mcp"],
  ): Promise<SessionScope> {
    // ponytail: a scope for each `--mcp-config` lives, with its servers, as long as the daemon.
    const key =
      mcp === undefined
        ? sessionId
        : `${sessionId}.mcp-${createHash("sha256").update(JSON.stringify(mcp)).digest("hex").slice(0, 16)}`;
    const servers = mcp === undefined ? mcpServers : { ...(mcp.strict ? {} : mcpServers), ...mcp.servers };
    const existing = sessionScopes.get(key);
    if (existing) return existing;
    const pending = scopePromises.get(key);
    if (pending) return pending;
    const promise = (async () => {
      let teamParent: string | undefined;
      for (const team of teamContexts.values()) {
        if (team.sessions.has(sessionId)) {
          teamParent = team.parentSessionId;
          break;
        }
      }
      const websearch = await webSearchFor(config, getCtx());
      const scope = await createSessionScope({
        deps: {
          identity,
          capabilities: { tools: "*", pathScopes: "*", network: sandboxNetwork(config.sandbox) },
          sandbox,
        },
        http,
        workspaceRoot: options.workspaceRoot,
        snapshotDir,
        snapshotJournalFile: join(snapshotDir, "journals", `${sessionId}.journal.jsonl`),
        formatter: config.formatter,
        windowsShell: sandboxWindowsShell(config),
        ...(websearch ? { websearch } : {}),
        todoPersistence,
        mcpServers: teamMcpDedicatedServers(servers, teamParent),
        lspServers: config.lspServers,
        mcpTokens,
        ...(config.memory === false ? {} : { memoryFile: memoryFile(options.workspaceRoot) }),
        identityFor: (_serverName, h) => ({ type: "agent", name: h ?? handle ?? "main" }),
      });
      await attachTeamMcpPool(teamMcpPools, servers, scope, {
        teamParent,
        ...(handle ? { handle } : {}),
        tokens: mcpTokens,
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
    scopePromises.set(key, promise);
    try {
      const scope = await promise;
      sessionScopes.set(key, scope);
      return scope;
    } finally {
      scopePromises.delete(key);
    }
  }
  return { sessionScopes, scopePromises, getOrCreateScope };
}
