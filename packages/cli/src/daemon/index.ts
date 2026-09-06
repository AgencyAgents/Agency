import { rmSync } from "node:fs";
import { join } from "node:path";
import {
  AgentRegistry,
  BoardStore,
  type Budget,
  ChannelStore,
  ChoiceLog,
  collectPluginAgents,
  configDir,
  createRotatingFileSink,
  DispatchStateStore,
  dataDir,
  EventBus,
  InboxStore,
  isTeamLive,
  Logger,
  loadCommands,
  loadConfig,
  loadPlugins,
  SessionStore,
  storagePaths,
  type ToolSpec,
  TraceRecorder,
} from "@agency/core";
import {
  ApprovalManager,
  type Capabilities,
  createFileTrustStore,
  PermissionsGate,
  Redactor,
  SandboxBoundary,
  type ToolPermissionValue,
  type TrustStore,
} from "@agency/guard";

import { createHttpClient } from "@agency/net";
import { createKeychain, type KeychainBackend, Scheduler } from "@agency/providers";
import {
  type DaemonServer,
  type HttpGatewayServer,
  newInstanceToken,
  PROTOCOL_VERSION,
  startDaemonServer,
  startHttpGateway,
  writeInstanceFile,
} from "@agency/rpc";
import { createFileTelemetrySink, Telemetry } from "@agency/telemetry";
import { createSessionScope, resolveShell, type SessionScope, type TeamMcpPool } from "@agency/tools";
import { registerCommandHandlers } from "./handlers/commands.ts";
import {
  demoteScopeForLead,
  registerBoardToolsForScope,
  registerCoordToolsForScope,
} from "./handlers/coords.ts";
import { buildDispatchTool } from "./handlers/dispatch.ts";
import { registerPlanHandlers } from "./handlers/plan.ts";
import {
  buildSpawnTool,
  registerSessionHandlers,
  defaultCapabilitiesForSession as sessionCapabilities,
  gateForSession as sessionGateFor,
  sessionToolsFor,
} from "./handlers/session.ts";
import { registerSurfaceHandlers } from "./handlers/surface.ts";
import { initTeamFromConfig, registerTeamHandlers } from "./handlers/team.ts";
import {
  attachTeamMcpPool,
  initTeamRunState,
  registerTeamRunHandlers,
  remapRosterToCredentials,
  teamMcpDedicatedServers,
} from "./handlers/team-run.ts";
import { registerTraceHandlers } from "./handlers/trace.ts";
import { registerTurnHandlers } from "./handlers/turn.ts";
import { createModelCatalog } from "./model-catalog.ts";
import { buildStateSnapshot, sessionKeyForEvent } from "./state-snapshot.ts";
import { createTeamContext, type TeamContext } from "./team-context.ts";
import {
  type AgentDaemon,
  type AgentDaemonOptions,
  commandPolicyFromPermissions,
  createConfigFingerprint,
  type DaemonContext,
  DEFAULT_IDLE_LINGER_MS,
  resolveAdapter,
} from "./types.ts";

export * from "./types.ts";
export async function createAgentDaemon(options: AgentDaemonOptions): Promise<AgentDaemon> {
  const config = loadConfig({ globalDir: options.configDir, env: process.env });
  const providers = config.provider;

  // R11 wiring: every key that resolves anywhere in this process is registered
  // here, and the logger scrubs every line through the same redactor.
  const redactor = new Redactor();
  for (const providerConfig of Object.values(providers)) {
    if (providerConfig.apiKey) redactor.registerSecret(providerConfig.apiKey);
  }
  for (const [envKey, value] of Object.entries(process.env)) {
    if (envKey.startsWith("AGENCY_") && envKey.endsWith("_API_KEY") && value) {
      redactor.registerSecret(value);
    }
  }

  const eventBus = new EventBus();
  const rotatingSink = options.logsDir ? createRotatingFileSink({ dir: options.logsDir }) : undefined;
  const sink = rotatingSink
    ? (line: string) => rotatingSink.write(line)
    : (line: string) => console.log(line);
  const logger = new Logger({ level: config.logLevel, sink, redactor, bus: eventBus });
  eventBus.setLogger(logger);
  eventBus.emit("config.loaded", { config });
  eventBus.emit("event", { event: "config.loaded", payload: { config } });
  const telemetry = new Telemetry({
    enabled: config.telemetryEnabled,
    crashReports: { enabled: config.crashReportsEnabled },
    redactor,
    sink: createFileTelemetrySink(join(options.telemetryDir ?? dataDir(), "telemetry", "events.jsonl")),
  });

  const adapterFor = options.adapterFor ?? ((provider: string) => resolveAdapter(provider, providers));
  const http = options.http ?? createHttpClient();

  // Model metadata for pre-flight accounting (max output tokens, pricing):
  // resolved offline, never fetched on the turn path.
  const models = createModelCatalog(providers, config);
  const catalogModel = models.catalogModel;
  const resolveAgentModel = models.resolveAgentModel;

  const identity = options.identity ?? { type: "user" as const };
  const idleLingerMs = options.idleLingerMs ?? DEFAULT_IDLE_LINGER_MS;
  const authToken = options.authToken ?? newInstanceToken();

  // A5: the security stack is built from config, not constants. The gate owns
  // the permissions maps (allow/ask/deny, last-match-wins) and the trust
  // check; the sandbox gets the deny-pattern command policy and the
  // external_directory decision, so containment and policy are real.
  const trustStore: TrustStore = createFileTrustStore(
    options.trustStorePath ?? join(dataDir(), "trust.json"),
  );
  const gate = new PermissionsGate({
    permissions: config.permissions,
    workspaceRoot: options.workspaceRoot,
    trust: { store: trustStore, root: options.workspaceRoot, required: config.trust.required },
  });
  const commandPolicy = commandPolicyFromPermissions(config.permissions);
  const shellLabel = resolveShell(process.platform, config.windowsShell).label;
  const sandbox = new SandboxBoundary(options.workspaceRoot, commandPolicy, (resolved) =>
    gate.externalDirectoryDecision(resolved),
  );

  /**
   * Per-agent PermissionsGate: returns a gate sourced from the agent's own
   * `permissions` config (with absentToolsDenied so unlisted tools are filtered
   * entirely), or the global gate when the agent defines none. This is the
   * Phase 2 enforcement that makes per-agent tool policies real.
   */
  function gateForAgent(handle: string): PermissionsGate {
    const agentPermissions = config.agents?.[handle]?.permissions as
      | Record<string, ToolPermissionValue>
      | undefined;
    if (agentPermissions !== undefined) {
      return new PermissionsGate({
        permissions: agentPermissions,
        workspaceRoot: options.workspaceRoot,
        absentToolsDenied: true,
        trust: { store: trustStore, root: options.workspaceRoot, required: config.trust.required },
      });
    }
    return gate;
  }

  /** Derive capabilities from a per-agent gate: "*" when all tools pass, else the offered names. */
  function capabilitiesForAgent(agentGate: PermissionsGate, tools: ToolSpec[]): Capabilities {
    const offered = tools.filter((t) => agentGate.toolOffered(t.name, t.riskTier));
    return {
      tools: offered.length === tools.length ? ("*" as const) : offered.map((t) => t.name),
      pathScopes: "*" as const,
      network: "*" as const,
    };
  }

  /**
   * Detects a read-only agent: bash is offered but write and edit are denied.
   * Such agents get a filesystem-level read-only worktree so their shell
   * commands can read and run tests but cannot modify the source tree.
   */
  function isReadOnlyAgent(handle: string): boolean {
    const agentGate = gateForAgent(handle);
    const bashOffered = agentGate.toolOffered("bash", "dangerous");
    const writeOffered = agentGate.toolOffered("write", "moderate");
    const editOffered = agentGate.toolOffered("edit", "moderate");
    return bashOffered && !writeOffered && !editOffered;
  }

  // A3: API keys resolve daemon-side (this process has keychain access), so
  // the keychain is created lazily on the first keyless run_turn and reused.
  let keychainPromise: Promise<KeychainBackend> | undefined;
  const getKeychain = () => {
    keychainPromise ??= createKeychain(process.platform, join(dataDir(), "keys"));
    return keychainPromise;
  };

  const configFingerprint = createConfigFingerprint([
    join(options.configDir ?? configDir(), "config.jsonc"),
    join(options.workspaceRoot, ".agency", "config.jsonc"),
  ]);

  logger.info("daemon started", { workspaceRoot: options.workspaceRoot, protocolVersion: PROTOCOL_VERSION });

  // Todo persistence: todo_write/execute_plan append a todo_state entry to the
  // session's JSONL (daemon-owned), and each run_turn rehydrates from the
  // latest one, so todos survive daemon restarts and compaction.
  const todoSessionsDir = options.sessionsDir ?? storagePaths(options.workspaceRoot).sessionsDir;
  const todoStore = new SessionStore(todoSessionsDir, { bus: eventBus, logger });
  const warnPersistence = (action: string, error: unknown): void => {
    logger.warn(`persistence failed: ${action}`, {
      error: error instanceof Error ? error.message : String(error),
    });
  };
  const createTraceRecorder = (trace: {
    sessionsDir: string;
    sessionId: string;
    traceId: string;
    provider: string;
    model: string;
  }): TraceRecorder | undefined => {
    try {
      return new TraceRecorder({ ...trace, redactor });
    } catch (error: unknown) {
      warnPersistence("TraceRecorder create", error);
      return undefined;
    }
  };
  const todoPersistence = {
    async save(sessionId: string, todos: readonly { id: string; content: string; status: string }[]) {
      const entries = todoStore.load(sessionId);
      await todoStore.append(sessionId, {
        type: "todo_state",
        parentId: todoStore.latestTip(entries) ?? null,
        todos,
      });
    },
    load(sessionId: string) {
      const entries = todoStore.load(sessionId);
      for (let i = entries.length - 1; i >= 0; i--) {
        const entry = entries[i];
        if (entry?.type === "todo_state" && Array.isArray(entry.todos)) return entry.todos;
      }
      return undefined;
    },
  };

  const snapshotDir = storagePaths(options.workspaceRoot).snapshotsDir;

  const builtinsMode = options.tools === undefined;
  let tools: ToolSpec[] = [];
  let sharedPluginTools: ToolSpec[] = [];
  let pluginAgents: Array<{ pluginId: string; agent: import("@agency/core").PluginAgentContribution }> = [];
  if (builtinsMode) {
    const { ToolRegistry: SharedRegistry } = await import("@agency/tools");
    const sharedPluginRegistry = new SharedRegistry();
    const pluginResultEarly = await loadPlugins({
      workspaceRoot: options.workspaceRoot,
      configDirOverride: options.configDir,
      configPlugins: (config as { plugins?: string[] }).plugins,
      bus: eventBus,
      logger,
      registry: sharedPluginRegistry as unknown as never,
      capabilities: { tools: "*", pathScopes: "*", network: "none" },
      identity,
    });
    if (pluginResultEarly.errors.length > 0) {
      for (const e of pluginResultEarly.errors) logger.warn(`plugin "${e.id}" not loaded: ${e.error}`);
    }
    sharedPluginTools = sharedPluginRegistry.list();
    pluginAgents = collectPluginAgents(pluginResultEarly.plugins);
  } else {
    tools = options.tools ?? [];
    const { ToolRegistry } = await import("@agency/tools");
    const pluginToolRegistry = new ToolRegistry();
    for (const t of tools) pluginToolRegistry.register(t);
    const pluginResult = await loadPlugins({
      workspaceRoot: options.workspaceRoot,
      configDirOverride: options.configDir,
      configPlugins: (config as { plugins?: string[] }).plugins,
      bus: eventBus,
      logger,
      registry: pluginToolRegistry as unknown as never,
      capabilities: { tools: "*", pathScopes: "*", network: "none" },
      identity,
    });
    if (pluginResult.errors.length > 0) {
      for (const e of pluginResult.errors) logger.warn(`plugin "${e.id}" not loaded: ${e.error}`);
    }
    tools = pluginToolRegistry.list();
    pluginAgents = collectPluginAgents(pluginResult.plugins);
  }

  const activeTurnMeta = new Map<
    string,
    {
      capabilities: Capabilities;
      tools: ToolSpec[];
      sessionId: string;
      provider: string;
      model: string;
      apiKey: string;
      budget?: Budget;
      taskDepth?: number;
    }
  >();

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
        const spawnTool = buildSpawnTool(ctx, scope);
        if (!scope.registry.has("spawn")) scope.registry.register(spawnTool);
        try {
          const cfgAgents = (config as unknown as { agents?: Record<string, unknown> }).agents;
          const hasTeam = cfgAgents && Object.keys(cfgAgents).length > 1;
          if (hasTeam && !scope.registry.has("dispatch")) {
            const dispatchTool = buildDispatchTool(ctx, sessionId);
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
        await registerBoardToolsForScope(scope, ctx, ownerHandle, handle);
      } catch {}
      try {
        await registerCoordToolsForScope(scope, ctx, ownerHandle ?? handle ?? "lead");
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

  const commands = loadCommands({
    workspaceRoot: options.workspaceRoot,
    configDirOverride: options.configDir,
  });

  const defaultCapabilitiesSync: Capabilities =
    options.capabilities ??
    (builtinsMode
      ? { tools: "*", pathScopes: "*", network: "*" }
      : { tools: sessionToolsFor(tools, gate), pathScopes: "*", network: "*" });

  const teamRegistry = new AgentRegistry();
  const boardStore: BoardStore = new BoardStore({
    persist: async (todos) => {
      try {
        const sid = "team-shared";
        const entries = todoStore.load(sid);
        await todoStore.append(sid, {
          type: "todo_state",
          parentId: todoStore.latestTip(entries) ?? null,
          todos,
        });
      } catch (error: unknown) {
        warnPersistence("board persist", error);
      }
    },
  });
  const teamContexts = new Map<string, TeamContext>();
  const teamMcpPools = new Map<string, TeamMcpPool>();
  const teamFor = (parentSessionId: string): TeamContext => {
    let team = teamContexts.get(parentSessionId);
    if (!team) {
      team = createTeamContext(parentSessionId);
      teamContexts.set(parentSessionId, team);
    }
    return team;
  };
  const inboxStore = new InboxStore();
  const channelStore = new ChannelStore();
  const choiceLog = new ChoiceLog();
  const dispatchLog = new DispatchStateStore();
  try {
    const restored = await DispatchStateStore.load(join(todoSessionsDir, "dispatch-state.json"));
    for (const entry of restored.list()) dispatchLog.append(entry);
  } catch (error: unknown) {
    warnPersistence("dispatch-state restore", error);
  }
  const sessionInboxes = new Map<string, import("@agency/schema").Message[]>();

  // Session-scoped "always allow" grants: one manager per session id, persisted
  // to disk so grants survive daemon restart.
  const approvalManagers = new Map<string, ApprovalManager>();
  const approvalsDir = options.approvalsDir ?? join(dataDir(), "approvals");
  const approvalsFor = (sessionId: string): ApprovalManager => {
    let manager = approvalManagers.get(sessionId);
    if (!manager) {
      manager = new ApprovalManager(approvalsDir, sessionId);
      approvalManagers.set(sessionId, manager);
    }
    return manager;
  };

  // One scheduler per provider: a single shared bucket would pace all
  // providers against one 60-rpm ceiling and one concurrency cap, so a slow
  // provider's retries starve every other provider's requests. The team
  // limiter below is the binding constraint for fan-out; this headroom
  // keeps same-provider teams of five fully parallel.
  const schedulers = new Map<string, Scheduler>();
  const schedulerFor = (provider: string): Scheduler => {
    let scheduler = schedulers.get(provider);
    if (!scheduler) {
      scheduler = new Scheduler({ maxConcurrent: 8 });
      schedulers.set(provider, scheduler);
    }
    return scheduler;
  };
  const activeControllers = new Map<string, AbortController>();
  const turnOwners = new Map<string, string>();
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  let server!: DaemonServer;
  let httpGateway!: HttpGatewayServer;

  const ctx: DaemonContext = {
    options,
    config,
    providers,
    logger,
    eventBus,
    telemetry,
    http,
    redactor,
    adapterFor,
    schedulerFor,
    todoStore,
    boardStore,
    dispatchLog,
    inboxStore,
    channelStore,
    choiceLog,
    warnPersistence,
    createTraceRecorder,
    sessionScopes,
    getOrCreateScope,
    teamRegistry,
    pluginAgents,
    teamContexts,
    teamFor,
    sessionInboxes,
    gate,
    gateForAgent,
    isReadOnlyAgent,
    capabilitiesForAgent,
    gateForSession: (sessionId: string) => sessionGateFor(ctx, sessionId),
    defaultCapabilitiesForSession: (sessionId?: string) => sessionCapabilities(ctx, sessionId),
    defaultCapabilitiesSync,
    approvalsFor,
    approvalManagers,
    turnCheckpoints: new Map<string, Array<string | null>>(),
    teamCheckpoints: new Map(),
    teamMcpPools,
    listModels: models.listModels,
    activeControllers,
    turnOwners,
    activeTurnMeta,
    commands,
    catalogModel,
    resolveAgentModel,
    getKeychain,
    configFingerprint,
    broadcast,
    identity,
    sandbox,
    shellLabel,
    todoSessionsDir,
    builtinsMode,
    tools,
  };

  try {
    initTeamFromConfig(ctx);
  } catch {}
  try {
    remapRosterToCredentials(ctx);
  } catch {}
  initTeamRunState(ctx);

  const handlers: Record<string, import("@agency/rpc").MethodHandler> = {};

  registerTurnHandlers(handlers, ctx);
  registerSessionHandlers(handlers, ctx);
  registerSurfaceHandlers(handlers, ctx);
  registerTraceHandlers(handlers, ctx);
  registerPlanHandlers(handlers, ctx);
  registerCommandHandlers(handlers, ctx);

  registerTeamHandlers(handlers, ctx);
  registerTeamRunHandlers(handlers, ctx);

  server = await startDaemonServer({
    token: authToken,
    handlers,
    onClientCount(count) {
      if (count > 0) {
        clearTimeout(idleTimer);
        idleTimer = undefined;
        return;
      }
      idleTimer = setTimeout(() => {
        try {
          eventBus.emit("session.idle", {});
          eventBus.emit("event", { event: "session.idle", payload: {} });
        } catch {}
        options.onIdleShutdown?.();
      }, idleLingerMs);
    },

    onClientDisconnect(clientId) {
      for (const [turnId, owner] of turnOwners) {
        if (owner !== clientId) continue;
        turnOwners.delete(turnId);
        activeControllers.get(turnId)?.abort();
      }
    },
  });

  // Mount the HTTP+SSE gateway on the same handler table and auth token as
  // the TCP transport, so both transports answer the same RPC surface.
  const corsOrigins = (config as unknown as { http?: { corsOrigins?: string[] } }).http?.corsOrigins;
  httpGateway = startHttpGateway({
    handlers,
    token: authToken,
    store: todoStore,
    sessionForEvent: (event) => sessionKeyForEvent(ctx, event),
    stateSnapshot: (sessionId) => buildStateSnapshot(ctx, sessionId),
    ...(corsOrigins === undefined ? {} : { allowedOrigins: corsOrigins }),
  });

  /** Broadcasts an event to both TCP and HTTP+SSE subscribers. */
  function broadcast(event: string, payload: unknown): void {
    server.broadcast(event, payload);
    httpGateway.publish(event, payload);
  }

  writeInstanceFile(options.instanceFile, {
    port: server.port,
    httpPort: httpGateway.port,
    pid: process.pid,
    startedAt: new Date().toISOString(),
    version: PROTOCOL_VERSION,
    token: authToken,
  });

  return {
    server,
    httpPort: httpGateway.port,
    async stop() {
      if (stopped) return;
      stopped = true;
      clearTimeout(idleTimer);
      if (builtinsMode) {
        for (const scope of sessionScopes.values()) {
          try {
            scope.processManager.killAll();
          } catch {}
        }
        for (const scope of [...sessionScopes.values()]) {
          try {
            await scope.dispose();
          } catch {}
        }
        sessionScopes.clear();
        scopePromises.clear();
      }
      for (const manager of approvalManagers.values()) manager.rejectAll();
      // SSE streams must end before the HTTP server stops (ECONNRESET).
      await httpGateway.close();
      await server.close();
      rmSync(options.instanceFile, { force: true });
      await rotatingSink?.flush();
    },
  };
}
