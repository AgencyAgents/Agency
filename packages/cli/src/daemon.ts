import { rmSync } from "node:fs";
import { join } from "node:path";
import {
  type Budget,
  buildEnvironmentBlock,
  composeSystemPrompt,
  createRotatingFileSink,
  dataDir,
  type GitRunner,
  gatherEnvironmentInfo,
  Logger,
  type LoopEvent,
  loadConfig,
  mcpServerDownReminder,
  type ProviderConfig,
  runTurn,
  SessionStore,
  type SystemReminder,
  storagePaths,
  type ToolSpec,
  withSystemReminders,
  withTrace,
} from "@agency/core";
import {
  ApprovalManager,
  type CallerIdentity,
  type Capabilities,
  createFileTrustStore,
  globToRegExpSource,
  PermissionsGate,
  Redactor,
  type RequestApproval,
  SandboxBoundary,
  type TrustStore,
} from "@agency/guard";
import type { HttpClient } from "@agency/net";
import { createHttpClient } from "@agency/net";
import {
  anthropicAdapter,
  BUILTIN_MODELS,
  createKeychain,
  createOpenAiCompatibleAdapter,
  googleAdapter,
  type KeychainBackend,
  loadCachedCatalog,
  type ModelInfo,
  mergeCatalogWithConfig,
  openaiAdapter,
  type ProviderAdapter,
  resolveApiKey,
  Scheduler,
  type ThinkingLevel,
  type Usage,
} from "@agency/providers";
import {
  type DaemonServer,
  newInstanceToken,
  PROTOCOL_VERSION,
  startDaemonServer,
  writeInstanceFile,
} from "@agency/rpc";
import { AgencyError, ErrorCode, type Message, type StopReason } from "@agency/schema";
import { createFileTelemetrySink, Telemetry } from "@agency/telemetry";
import { createBuiltinTools, writeApprovalRecord } from "@agency/tools";
import { listProviders } from "./providers-list.ts";

export const DEFAULT_SYSTEM_PROMPT =
  "You are Agency, a coding agent working in the user's project. Be direct and precise.";

/**
 * Composable alternative to a pre-built `systemPrompt` string. When any of
 * `identity`/`role`/`instructions` is present, the daemon composes the prompt
 * via `composeSystemPrompt` (identity -> role -> instructions) and appends the
 * environment block it assembles itself from the workspace. Fields are
 * optional individually so a client can add just a role overlay, or just
 * instructions, on top of the default identity.
 */
export interface SystemPromptParts {
  /** Who the agent is; defaults to `DEFAULT_SYSTEM_PROMPT` when other parts are set. */
  identity?: string;
  /** Mode/family overlay (e.g. plan-mode framing) joined after the identity. */
  role?: string;
  /** Project instructions, nearest-directory-first (loadInstructions' order). */
  instructions?: string[];
  /** Set false to omit the daemon-built environment block. */
  context?: boolean;
}

export interface RunTurnParams {
  turnId: string;
  provider: string;
  model: string;
  /**
   * Optional (A3): the daemon resolves the key itself — env -> keychain ->
   * config, the same layered precedence as every other surface — so keys no
   * longer travel the wire on every run_turn. An explicit value still wins,
   * for SDK callers and explicit-flag keys the daemon can't see.
   */
  apiKey?: string;
  /** Pre-composed system prompt. Used verbatim as the base section unless
   *  `systemPromptParts` overrides composition; kept required so every
   *  existing client over the wire stays exactly compatible. */
  systemPrompt: string;
  /** Compose from parts instead of using `systemPrompt` verbatim. */
  systemPromptParts?: SystemPromptParts;
  /** Dynamic notices active on THIS turn only (plan mode, changed files, dead
   *  MCP servers); rendered as one <system-reminder> block, absent otherwise. */
  systemReminders?: SystemReminder[];
  thinkingLevel?: ThinkingLevel;
  session: Message[];
  budget?: Budget;
  maxToolIterations?: number;
  /**
   * Session this turn belongs to: scopes the "always allow" approval grants
   * (they persist across the session's turns, never beyond the daemon
   * process) and is threaded into tool contexts.
   */
  sessionId?: string;
  /**
   * Per-turn capability override (A5): narrows what THIS turn may do, instead
   * of the daemon-wide set. Absent = the daemon-derived set from config.
   */
  capabilities?: Capabilities;
}

export interface ResolveSystemPromptOptions {
  workspaceRoot: string;
  /** MCP servers that failed to start; each becomes an mcp_server_down
   *  reminder for as long as the failure map is non-empty. */
  mcpFailures?: ReadonlyMap<string, string>;
  now?: Date;
  /** Test seam over git execution; defaults to `defaultGitRunner`. */
  git?: GitRunner;
}

/**
 * The daemon's single system-prompt path: the client's `systemPrompt` (or the
 * parts it sent) becomes the stable base, the daemon appends the environment
 * block it owns (it runs in the workspace and sees the real fs/git state), and
 * per-turn reminders are appended only when the turn actually has any. The
 * base sections are identical across turns, so the provider's prompt-cache
 * prefix survives; only the dynamic tail changes.
 */
export function resolveSystemPrompt(params: RunTurnParams, options: ResolveSystemPromptOptions): string {
  const parts = params.systemPromptParts;
  const identity = parts?.identity;
  const role = parts?.role;
  const instructions = parts?.instructions;
  const composeFromParts = identity !== undefined || role !== undefined || instructions !== undefined;

  const context =
    parts?.context === false
      ? undefined
      : buildEnvironmentBlock(
          gatherEnvironmentInfo({ cwd: options.workspaceRoot, now: options.now, git: options.git }),
        );

  const composed = composeSystemPrompt({
    base: composeFromParts ? (identity ?? DEFAULT_SYSTEM_PROMPT) : params.systemPrompt,
    familyPresetOverlay: composeFromParts ? role : undefined,
    instructions: composeFromParts ? (instructions ?? []) : [],
    toolDescriptions: [],
    context,
  });

  const reminders: SystemReminder[] = [...(params.systemReminders ?? [])];
  if (options.mcpFailures) {
    for (const [name, reason] of options.mcpFailures) reminders.push(mcpServerDownReminder(name, reason));
  }
  return withSystemReminders(composed, reminders).text;
}

export interface RunTurnRpcResult {
  messages: Message[];
  stopReason: StopReason;
  usage: Usage;
  budgetExceeded: boolean;
  cancelled: boolean;
  /** Set when the turn failed with CONTEXT_OVERFLOW: the daemon produced no
   *  assistant messages, so the caller (which owns the SessionStore) can
   *  compact the session and retry the turn. */
  needsCompaction?: boolean;
}

/**
 * Adapter resolution over the merged provider set: a config-defined provider
 * speaks its declared family's wire format (defaulting to openai-compatible,
 * which makes any OpenAI-shaped gateway work with zero adapter code), a
 * builtin family id falls back to its native adapter, and a catalog provider
 * with a known API base URL gets the openai-compatible adapter pointed there.
 * Unknown ids still throw, but only after every layer had its chance.
 */
export function resolveAdapter(
  providerId: string,
  providers: Record<string, ProviderConfig>,
  catalogBaseUrls: Record<string, string> = {},
): ProviderAdapter {
  const config = providers[providerId];
  if (config) {
    const family = config.family ?? "openai-compatible";
    if (family === "openai-compatible") {
      const baseUrl = config.baseUrl ?? catalogBaseUrls[providerId];
      if (!baseUrl) {
        throw new Error(`provider "${providerId}" needs a baseUrl (no native endpoint for its family)`);
      }
      return createOpenAiCompatibleAdapter(providerId, baseUrl);
    }
    if (family === "openai") return openaiAdapter;
    if (family === "anthropic") return anthropicAdapter;
    return googleAdapter;
  }

  switch (providerId) {
    case "anthropic":
      return anthropicAdapter;
    case "openai":
      return openaiAdapter;
    case "google":
      return googleAdapter;
    default: {
      const catalogBaseUrl = catalogBaseUrls[providerId];
      if (catalogBaseUrl) return createOpenAiCompatibleAdapter(providerId, catalogBaseUrl);
      throw new Error(`unknown provider: ${providerId}`);
    }
  }
}

export interface AgentDaemonOptions {
  workspaceRoot: string;
  instanceFile: string;
  /** How long to stay alive after the last client disconnects before exiting. */
  idleLingerMs?: number;
  /** Defaults to the real built-in adapters; tests substitute fakes here. */
  adapterFor?: (provider: string) => ProviderAdapter;
  http?: HttpClient;
  /** Defaults to the real P4 built-in set (read/write/edit/bash/grep/glob/
   *  fetch/todo); tests substitute a smaller fake set here. */
  tools?: ToolSpec[];
  identity?: CallerIdentity;
  capabilities?: Capabilities;
  /** Overrides the on-disk config; tests inject a minimal layer here. */
  configDir?: string;
  /** Pre-loaded catalog models for providers_list; skips the models.dev fetch. */
  catalog?: readonly ModelInfo[];
  /** When set, structured logs persist here (rotated JSONL); the real daemon
   *  passes logDir(). Tests omit it and get a console sink. */
  logsDir?: string;
  /** Overrides where telemetry events land; defaults to dataDir()/telemetry. */
  telemetryDir?: string;
  /**
   * Overrides the per-instance TCP auth token; defaults to a fresh 256-bit
   * random token per daemon. The token lands in the instance file (written
   * user-only), which is the only place clients can learn it.
   */
  authToken?: string;
  /**
   * Overrides the trust store location; defaults to dataDir()/trust.json.
   * Tests point this at a temp file so trust decisions never leak between runs.
   */
  trustStorePath?: string;
  /**
   * Overrides where the todo-persistence SessionStore reads/writes; defaults
   * to the workspace's storagePaths sessionsDir. Tests point this at a temp
   * dir so todo_state entries never leak between runs.
   */
  sessionsDir?: string;
  /** Called instead of process.exit so tests can observe an idle shutdown. */
  onIdleShutdown?: () => void;
}

export interface AgentDaemon {
  server: DaemonServer;
  stop(): Promise<void>;
}

/**
 * Builds the sandbox's hard command backstop from the permissions config:
 * every `bash` pattern mapped to `deny` becomes an anchored deny regex, so a
 * deny-listed command is refused at the sandbox even if a caller bypasses the
 * interactive gate. Allowlists aren't derived — `ask`/`allow` ordering is the
 * gate's job, the sandbox only ever vetoes.
 */
export function commandPolicyFromPermissions(
  permissions: Record<string, unknown>,
): { deny: RegExp[] } {
  const bash = (permissions as { bash?: unknown }).bash;
  const deny: RegExp[] = [];
  if (bash && typeof bash === "object" && !Array.isArray(bash)) {
    for (const [pattern, decision] of Object.entries(bash as Record<string, unknown>)) {
      if (decision === "deny") deny.push(new RegExp(globToRegExpSource(pattern, "command")));
    }
  }
  return { deny };
}

/**
 * Wires the RPC transport to the agent loop: this is the actual `agencyd`
 * body, spawned as a separate process by `ensureDaemon`'s caller and shared
 * by every client (TUI, headless, SDK) that attaches to this workspace root.
 */
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

  const rotatingSink = options.logsDir ? createRotatingFileSink({ dir: options.logsDir }) : undefined;
  const sink = rotatingSink
    ? (line: string) => rotatingSink.write(line)
    : (line: string) => console.log(line);
  const logger = new Logger({ level: config.logLevel, sink, redactor });
  const telemetry = new Telemetry({
    enabled: config.telemetryEnabled,
    crashReports: { enabled: config.crashReportsEnabled },
    redactor,
    sink: createFileTelemetrySink(join(options.telemetryDir ?? dataDir(), "telemetry", "events.jsonl")),
  });

  const adapterFor = options.adapterFor ?? ((provider: string) => resolveAdapter(provider, providers));
  const http = options.http ?? createHttpClient();

  // Model metadata for pre-flight accounting (max output tokens, pricing):
  // resolved offline from the on-disk catalog cache (populated by the
  // /models picker's providers_list fetch) or the build-time snapshot, with
  // config model overrides merged on top. The turn path never fetches.
  let mergedCatalog: ModelInfo[] | undefined;
  const catalogModel = (provider: string, model: string): ModelInfo | undefined => {
    mergedCatalog ??= mergeCatalogWithConfig(
      loadCachedCatalog(join(dataDir(), "cache"))?.models ?? BUILTIN_MODELS,
      providers,
    );
    return mergedCatalog.find((m) => m.id === model && m.family === provider);
  };

  const identity = options.identity ?? { type: "user" as const };
  const idleLingerMs = options.idleLingerMs ?? 10 * 60 * 1000;
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
  const sandbox = new SandboxBoundary(options.workspaceRoot, commandPolicy, (resolved) =>
    gate.externalDirectoryDecision(resolved),
  );

  // Two-level policy: a tool the permissions config bare-denies (or, under a
  // per-agent policy, omits) is not in the list the model ever sees. When
  // nothing is filtered, tools stay "*" so requireTool keeps its fast path.
  const sessionTools = () => {
    const offered = tools.filter((t) => gate.toolOffered(t.name, t.riskTier));
    return offered.length === tools.length ? ("*" as const) : offered.map((t) => t.name);
  };

  // A3: API keys resolve daemon-side (this process has keychain access), so
  // the keychain is created lazily on the first keyless run_turn and reused.
  let keychainPromise: Promise<KeychainBackend> | undefined;
  const getKeychain = () => {
    keychainPromise ??= createKeychain(process.platform, join(dataDir(), "keys"));
    return keychainPromise;
  };

  logger.info("daemon started", { workspaceRoot: options.workspaceRoot, protocolVersion: PROTOCOL_VERSION });

  // Todo persistence: todo_write/execute_plan append a todo_state entry to the
  // session's JSONL (daemon-owned), and each run_turn rehydrates from the
  // latest one — so todos survive daemon restarts and compaction.
  const todoSessionsDir = options.sessionsDir ?? storagePaths(options.workspaceRoot).sessionsDir;
  const todoStore = new SessionStore(todoSessionsDir);
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

  const builtins = options.tools
    ? undefined
    : await createBuiltinTools({
        deps: { identity, capabilities: { tools: "*", pathScopes: "*", network: "*" }, sandbox },
        http,
        workspaceRoot: options.workspaceRoot,
        snapshotDir: storagePaths(options.workspaceRoot).snapshotsDir,
        formatter: config.formatter,
        windowsShell: config.windowsShell,
        ...(config.websearch?.endpoint ? { websearch: { endpoint: config.websearch.endpoint } } : {}),
        todoPersistence,
        mcpServers: config.mcpServers,
        lspServers: config.lspServers,
      });
  const tools = options.tools ?? builtins?.tools ?? [];
  const defaultCapabilities: Capabilities = options.capabilities ?? {
    tools: sessionTools(),
    pathScopes: "*",
    network: "*",
  };

  // Session-scoped "always allow" grants: one manager per session id, alive
  // as long as the daemon process — never beyond it.
  const approvalManagers = new Map<string, ApprovalManager>();
  const approvalsFor = (sessionId: string): ApprovalManager => {
    let manager = approvalManagers.get(sessionId);
    if (!manager) {
      manager = new ApprovalManager();
      approvalManagers.set(sessionId, manager);
    }
    return manager;
  };

  // One scheduler per provider: a single shared bucket would pace all
  // providers against one 60-rpm ceiling and one concurrency cap, so a slow
  // provider's retries starve every other provider's requests.
  const schedulers = new Map<string, Scheduler>();
  const schedulerFor = (provider: string): Scheduler => {
    let scheduler = schedulers.get(provider);
    if (!scheduler) {
      scheduler = new Scheduler();
      schedulers.set(provider, scheduler);
    }
    return scheduler;
  };
  const activeControllers = new Map<string, AbortController>();
  /** Which client connection owns each in-flight turn: its disconnect (A3)
   *  cancels the turn, so a dead TUI stops the daemon burning tokens. */
  const turnOwners = new Map<string, string>();
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;

  const server = await startDaemonServer({
    token: authToken,
    handlers: {
      async run_turn(rawParams, context) {
        const params = rawParams as RunTurnParams;
        const controller = new AbortController();
        activeControllers.set(params.turnId, controller);
        turnOwners.set(params.turnId, context.clientId);
        const eventStream = `turn.${params.turnId}`;

        // R10 wiring: the whole turn — provider requests and tool calls —
        // correlates under one trace ID in the logs.
        return withTrace(async () => {
          // Turn heartbeats keep heartbeat-aware clients' deadlines alive
          // through silent stretches (a long tool call emits no deltas).
          const turnHeartbeat = setInterval(() => {
            server.broadcast(eventStream, { type: "heartbeat" });
          }, 10_000);
          try {
            const apiKey =
              params.apiKey ??
              (await (async () => {
                let keychain: KeychainBackend | undefined;
                try {
                  keychain = await getKeychain();
                } catch {
                  // No usable keychain: env/config resolution still applies.
                }
                return resolveApiKey({
                  provider: params.provider,
                  env: process.env,
                  keychain,
                  config: providers[params.provider]?.apiKey,
                });
              })());
            if (apiKey === undefined) {
              throw new Error(
                `no API key for provider "${params.provider}": set AGENCY_${params.provider.toUpperCase()}_API_KEY or run \`agency auth login ${params.provider}\``,
              );
            }
            redactor.registerSecret(apiKey);
            logger.info("turn started", {
              turnId: params.turnId,
              provider: params.provider,
              model: params.model,
            });
            const modelInfo = catalogModel(params.provider, params.model);
            const sessionId = params.sessionId ?? "default";
            // Rehydrate the shared TodoStore from this session's persisted
            // todos so a daemon restart (or a session switch) restores them.
            if (builtins?.todos) await builtins.todos.hydrate(sessionId);
            const approvals = approvalsFor(sessionId);
            // Approval asks broadcast on the turn stream (the requesting
            // client) and, when the client named a session, the session
            // stream (every surface attached to the room).
            const requestApproval: RequestApproval = async (request) => {
              if (approvals.hasAlways(request)) return "once";
              const { id, promise } = approvals.createPending(request, params.turnId);
              const payload = { type: "approval_requested" as const, requestId: id, request };
              server.broadcast(eventStream, payload);
              if (params.sessionId !== undefined) server.broadcast(`session.${sessionId}`, payload);
              return await promise;
            };
            const result = await runTurn(adapterFor(params.provider), schedulerFor(params.provider), http, {
              identity,
              capabilities: params.capabilities ?? defaultCapabilities,
              toolPolicy: gate,
              requestApproval,
              systemPrompt: resolveSystemPrompt(params, {
                workspaceRoot: options.workspaceRoot,
                mcpFailures: builtins?.mcpFailures,
              }),
              tools: tools.filter((t) => gate.toolOffered(t.name, t.riskTier)),
              model: params.model,
              apiKey,
              thinkingLevel: params.thinkingLevel,
              session: params.session,
              budget: params.budget,
              pricePerMTok: modelInfo
                ? {
                    input: modelInfo.pricing.inputPerMTok,
                    output: modelInfo.pricing.outputPerMTok,
                  }
                : undefined,
              maxTokensPerRequest: modelInfo?.maxOutputTokens,
              turnId: params.turnId,
              sessionId: params.sessionId,
              cwd: options.workspaceRoot,
              maxToolIterations: params.maxToolIterations,
              signal: controller.signal,
              onEvent: (event: LoopEvent) => server.broadcast(eventStream, event),
            });

            logger.info("turn finished", {
              turnId: params.turnId,
              stopReason: result.stopReason,
              inputTokens: result.usage.inputTokens,
              outputTokens: result.usage.outputTokens,
              cachedInputTokens: result.usage.cachedInputTokens ?? null,
            });
            telemetry.record("turn_complete", {
              provider: params.provider,
              stopReason: result.stopReason,
              inputTokens: result.usage.inputTokens,
              outputTokens: result.usage.outputTokens,
              cachedInputTokens: result.usage.cachedInputTokens ?? null,
            });

            const response: RunTurnRpcResult = { ...result, cancelled: controller.signal.aborted };
            return response;
          } catch (error) {
            if (error instanceof AgencyError && error.code === ErrorCode.CONTEXT_OVERFLOW) {
              // The loop throws before pushing any assistant message, so the
              // input session is the full message list. Report the overflow as
              // a result instead of an RPC error: the caller owns the
              // SessionStore and is the one who can compact and retry.
              logger.warn("context overflow — client should compact and retry", {
                turnId: params.turnId,
                provider: params.provider,
                model: params.model,
              });
              const response: RunTurnRpcResult = {
                messages: params.session,
                stopReason: "error",
                usage: { inputTokens: 0, outputTokens: 0 },
                budgetExceeded: false,
                cancelled: controller.signal.aborted,
                needsCompaction: true,
              };
              return response;
            }
            logger.error("turn failed", {
              turnId: params.turnId,
              error: error instanceof Error ? error.message : String(error),
            });
            telemetry.recordCrash("run_turn", error);
            throw error;
          } finally {
            clearInterval(turnHeartbeat);
            // A turn that died (abort, disconnect, error) must not leave asks
            // pending forever: reject anything it was waiting on.
            approvalsFor(params.sessionId ?? "default").rejectTurn(params.turnId);
            activeControllers.delete(params.turnId);
            turnOwners.delete(params.turnId);
          }
        });
      },

      async cancel_turn(rawParams) {
        const { turnId } = rawParams as { turnId: string };
        const controller = activeControllers.get(turnId);
        if (!controller) return { cancelled: false };
        controller.abort();
        return { cancelled: true };
      },

      // The other half of the approval gate: the UI's once/always/reject
      // answer lands here. "always" records a session-scoped grant inside the
      // ApprovalManager and retroactively resolves matching pending asks.
      async approval_respond(rawParams) {
        const { requestId, decision, sessionId } = rawParams as {
          requestId: string;
          decision: "once" | "always" | "reject";
          sessionId?: string;
        };
        if (decision !== "once" && decision !== "always" && decision !== "reject") {
          throw new AgencyError(ErrorCode.INTERNAL, `invalid approval decision: ${String(decision)}`, {
            source: "approval",
          });
        }
        const managers = sessionId ? [approvalManagers.get(sessionId)] : [...approvalManagers.values()];
        for (const manager of managers) {
          const outcome = manager?.respond(requestId, decision);
          if (outcome?.resolved) return outcome;
        }
        return { resolved: false, retroactive: 0 };
      },

      // Plan mode's approve half: writes the plan_approval companion record
      // (path + content hash + approver) after refusing plans with
      // unresolved comments. execute_plan refuses to run without it.
      async plan_approve(rawParams) {
        const { path, approvedBy } = rawParams as { path: string; approvedBy?: string };
        if (typeof path !== "string" || path.length === 0) {
          throw new AgencyError(ErrorCode.INTERNAL, "plan_approve requires a plan path", {
            source: "plan",
          });
        }
        const resolved = sandbox.resolvePath(path);
        try {
          const record = writeApprovalRecord(resolved, { approvedBy });
          return { record };
        } catch (error) {
          throw new AgencyError(
            ErrorCode.TOOL_ERROR,
            error instanceof Error ? error.message : String(error),
            { source: "plan", context: { path } },
          );
        }
      },

      // File undo/redo over the write/edit snapshot journal. The daemon owns
      // the SnapshotStore (tools run here, not in clients), so /undo and
      // /redo in a TUI must come through as RPC, like every other effect.
      async undo() {
        const snapshots = options.tools ? undefined : builtins?.snapshots;
        const outcome = snapshots?.undo();
        return { undone: outcome !== undefined, ...(outcome ? { path: outcome.path } : {}) };
      },

      async redo() {
        const snapshots = options.tools ? undefined : builtins?.snapshots;
        const outcome = snapshots?.redo();
        return { undone: outcome !== undefined, ...(outcome ? { path: outcome.path } : {}) };
      },

      async providers_list() {
        const base = await listProviders({ config, http, catalog: options.catalog });
        const mcpFailures = builtins?.mcpFailures ? Object.fromEntries(builtins.mcpFailures) : {};
        const lspStatuses = builtins?.lspRegistry?.statuses() ?? {};
        return { ...base, mcpFailures, lspStatuses };
      },

      async mcp_status() {
        return { failures: builtins?.mcpFailures ? Object.fromEntries(builtins.mcpFailures) : {} };
      },

      async lsp_status() {
        return { statuses: builtins?.lspRegistry?.statuses() ?? {} };
      },
    },

    onClientCount(count) {
      if (count > 0) {
        clearTimeout(idleTimer);
        idleTimer = undefined;
        return;
      }
      idleTimer = setTimeout(() => {
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

  writeInstanceFile(options.instanceFile, {
    port: server.port,
    pid: process.pid,
    startedAt: new Date().toISOString(),
    version: PROTOCOL_VERSION,
    token: authToken,
  });

  return {
    server,
    async stop() {
      if (stopped) return;
      stopped = true;
      clearTimeout(idleTimer);
      builtins?.processManager.killAll();
      await builtins?.dispose();
      // Shutdown must not leave any client's approval promise hanging.
      for (const manager of approvalManagers.values()) manager.rejectAll();
      await server.close();
      // Graceful shutdown clears its own instance file: clients probing the
      // old port refuse fast instead of timing out against a dead pid.
      rmSync(options.instanceFile, { force: true });
      // Async log sink: flush queued lines so the shutdown record survives.
      await rotatingSink?.flush();
    },
  };
}
