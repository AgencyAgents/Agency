import { rmSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  AgentRegistry,
  type Budget,
  buildEnvironmentBlock,
  buildSpanTree,
  composeSystemPrompt,
  configDir,
  createDispatchTool,
  createRotatingFileSink,
  createWorktree,
  dataDir,
  EventBus,
  expandCommand,
  type GitRunner,
  gatherEnvironmentInfo,
  generateTitle,
  getSessionTitle,
  Logger,
  type LoopEvent,
  leanBrief,
  leanPrompt,
  leanSummary,
  loadCommands,
  loadConfig,
  loadPlugins,
  loadTraceSpansSync,
  makeWorktreeReadOnly,
  mcpServerDownReminder,
  newEntryId,
  OrchestraTodoStore,
  PromiseBarrier,
  type ProviderConfig,
  parseHandles,
  parseModelRef,
  parseSlashInput,
  readCassetteRecord,
  resolveSmallModel,
  runTurn,
  SessionStore,
  type SystemReminder,
  spansToOtlp,
  spawnParallel,
  storagePaths,
  type ToolSpec,
  TraceRecorder,
  withSystemReminders,
  withTrace,
} from "@agency/core";
import {
  ApprovalManager,
  type CallerIdentity,
  type Capabilities,
  checkCostForecast,
  createFileTrustStore,
  type DispatchAgentForecast,
  estimateDispatchCost,
  globToRegExpSource,
  PermissionsGate,
  Redactor,
  type RequestApproval,
  SandboxBoundary,
  type ToolPermissionValue,
  type TrustStore,
} from "@agency/guard";
import type { HttpClient } from "@agency/net";
import { createHttpClient } from "@agency/net";
import {
  anthropicAdapter,
  BUILTIN_MODELS,
  clampEffortForModel,
  classifyEffortFromText,
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
  type HttpGatewayServer,
  newInstanceToken,
  PROTOCOL_VERSION,
  startDaemonServer,
  startHttpGateway,
  writeInstanceFile,
} from "@agency/rpc";
import { AgencyError, ErrorCode, type Message, type StopReason } from "@agency/schema";
import { createFileTelemetrySink, Telemetry } from "@agency/telemetry";
import {
  createSessionScope,
  createTaskTool,
  extractFinalText,
  resolveShell,
  type SessionScope,
  writeApprovalRecord,
} from "@agency/tools";
import { listProviders } from "./providers-list.ts";

export const DEFAULT_SYSTEM_PROMPT =
  "You are Agency, a coding agent working in the user's project. Be direct and precise.\n" +
  "Safety first: never exfiltrate secrets or write credentials to logs or output; " +
  "never run destructive commands (recursive deletes, disk wipes, mass permission changes) " +
  "without explicit user approval; prefer reversible edits and confirm before overwriting " +
  "files you have not read in this session.\n" +
  "Coding conventions: match the repo's existing style and formatter; keep diffs small and " +
  "focused with no drive-by refactors; run the typechecker and the relevant tests after " +
  "each logical change and fix failures before moving on.\n" +
  "Tool-use doctrine: read a file before editing it and never trust stale line numbers; " +
  "batch independent reads and searches in parallel; use the shell only for building, " +
  "testing, linting, and running the project — never as a substitute for the read/write/edit " +
  "tools; report command output verbatim when it matters and summarize otherwise.\n" +
  "Shell dialect: commands run in the session shell named in the environment block — " +
  "write every command in that shell's syntax (PowerShell, cmd.exe, and POSIX sh differ " +
  "in quoting, chaining, and env-var expansion); default to POSIX sh only when no shell " +
  "is named.";

export const HEARTBEAT_INTERVAL_MS = 10_000;
export const DEFAULT_IDLE_LINGER_MS = 10 * 60 * 1000;

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
  images?: import("@agency/schema").ImageBlock[];
  promptVersion?: string;
}

export interface ResolveSystemPromptOptions {
  workspaceRoot: string;
  /** MCP servers that failed to start; each becomes an mcp_server_down
   *  reminder for as long as the failure map is non-empty. */
  mcpFailures?: ReadonlyMap<string, string>;
  now?: Date;
  /** Test seam over git execution; defaults to `defaultGitRunner`. */
  git?: GitRunner;
  /** Shell label for the environment block (resolveShell(...).label), so the
   *  model writes commands in the session shell's dialect. */
  shellLabel?: string;
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

  if (parts?.context === false) {
    console.warn(
      "[agency] systemPromptParts.context=false omits the environment block (os/cwd/date/git/shell): the model loses workspace orientation.",
    );
  }
  const context =
    parts?.context === false
      ? undefined
      : buildEnvironmentBlock(
          gatherEnvironmentInfo({
            cwd: options.workspaceRoot,
            now: options.now,
            git: options.git,
            shell: options.shellLabel,
          }),
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

function oauthOverridesFor(
  providerId: string,
  providers: Record<string, ProviderConfig>,
): { oauthClientId: string | undefined; oauthBaseUrl: string | undefined } {
  const oauth = providers[providerId]?.oauth;
  return { oauthClientId: oauth?.clientId, oauthBaseUrl: oauth?.baseUrl };
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
  /**
   * Overrides where per-session approval grants persist; defaults to
   * dataDir()/approvals. Tests point this at a temp dir so "always" grants
   * never leak between runs (a persisted grant would answer future asks
   * without broadcasting approval_requested).
   */
  approvalsDir?: string;
  /** Called instead of process.exit so tests can observe an idle shutdown. */
  onIdleShutdown?: () => void;
}

export interface AgentDaemon {
  server: DaemonServer;
  /** The HTTP+SSE gateway port (0 if not started). */
  httpPort: number;
  stop(): Promise<void>;
}

/**
 * Builds the sandbox's hard command backstop from the permissions config:
 * every `bash` pattern mapped to `deny` becomes an anchored deny regex, so a
 * deny-listed command is refused at the sandbox even if a caller bypasses the
 * interactive gate. Allowlists aren't derived — `ask`/`allow` ordering is the
 * gate's job, the sandbox only ever vetoes.
 */
export function commandPolicyFromPermissions(permissions: Record<string, unknown>): { deny: RegExp[] } {
  const bash = (permissions as { bash?: unknown }).bash;
  const deny: RegExp[] = [];
  if (bash && typeof bash === "object" && !Array.isArray(bash)) {
    for (const [pattern, decision] of Object.entries(bash as Record<string, unknown>)) {
      if (decision === "deny") deny.push(new RegExp(globToRegExpSource(pattern, "command")));
    }
  }
  return { deny };
}

export interface OrchestraBudgets {
  perAgentUsd?: number;
  orchestraUsd?: number;
}

/** Hard caps: throw before dispatch when a budget is already spent. */
export function checkOrchestraBudgets(params: {
  budgets?: OrchestraBudgets;
  perAgentSpend: ReadonlyMap<string, number>;
  orchestraTotal: number;
  handles: readonly string[];
}): void {
  const perAgentUsd = params.budgets?.perAgentUsd;
  if (perAgentUsd !== undefined) {
    for (const handle of params.handles) {
      const spent = params.perAgentSpend.get(handle) ?? 0;
      if (spent >= perAgentUsd) {
        throw new Error(`budget exceeded: per-agent ${handle} ${spent} >= ${perAgentUsd}`);
      }
    }
  }
  const orchestraUsd = params.budgets?.orchestraUsd;
  if (orchestraUsd !== undefined && params.orchestraTotal >= orchestraUsd) {
    throw new Error(`orchestra budget exceeded: ${params.orchestraTotal} >= ${orchestraUsd}`);
  }
}

/**
 * Replaces the keyword-heuristic effort classification with a small-model
 * call for the no-dispatcher @leader case. Falls back to the keyword
 * heuristic when no small_model is configured or the call fails.
 * Traced as its own span when a traceRecorder is available.
 */
export async function classifyEffortWithSmallModel(
  text: string,
  opts: {
    config: Record<string, unknown>;
    adapterFor: (provider: string) => ProviderAdapter;
    http: HttpClient;
    apiKey: string;
    providers: Record<string, { apiKey?: string; family?: string; baseUrl?: string }>;
    traceRecorder?: TraceRecorder;
  },
): Promise<string> {
  const resolved = resolveSmallModel(opts.config as import("@agency/core").Config);
  if (!resolved) return classifyEffortFromText(text) as string;

  let spanId: string | null = null;
  if (opts.traceRecorder) {
    spanId = opts.traceRecorder.startSpan({
      name: "effort-classification",
      kind: "tool",
      parentId: null,
      attributes: { model: resolved.model, provider: resolved.provider },
    });
  }

  try {
    let adapter: ProviderAdapter;
    try {
      adapter = opts.adapterFor(resolved.provider);
    } catch {
      if (opts.traceRecorder && spanId) opts.traceRecorder.endSpan(spanId, { status: "error" });
      return classifyEffortFromText(text) as string;
    }

    const messages: Message[] = [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: `Classify the effort level for this task as one word: minimal, low, medium, or high. Reply with ONLY the word. Task: ${text.slice(0, 1000)}`,
          },
        ],
      },
    ];

    let result = "";
    for await (const event of adapter.stream(
      { model: resolved.model, apiKey: opts.apiKey, messages, maxTokens: 16 },
      opts.http,
    )) {
      if (event.type === "text_delta") result += event.text;
    }

    const cleaned = result.trim().toLowerCase();
    const levels = ["minimal", "low", "medium", "high"];
    const found = levels.find((l) => cleaned.includes(l));

    if (opts.traceRecorder && spanId) {
      opts.traceRecorder.endSpan(spanId, { status: "ok", attributes: { effort: found ?? "medium" } });
    }

    return found ?? "medium";
  } catch {
    if (opts.traceRecorder && spanId) {
      opts.traceRecorder.endSpan(spanId, { status: "error" });
    }
    return classifyEffortFromText(text) as string;
  }
}

export function createConfigFingerprint(paths: readonly string[]): { check(): boolean } {
  const snapshot = new Map<string, number>();
  for (const p of paths) {
    try {
      snapshot.set(p, statSync(p).mtimeMs);
    } catch {
      snapshot.set(p, 0);
    }
  }
  return {
    check: () => {
      for (const [p, prev] of snapshot) {
        let cur = 0;
        try {
          cur = statSync(p).mtimeMs;
        } catch {
          cur = 0;
        }
        if (cur !== prev) return true;
      }
      return false;
    },
  };
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
  // resolved offline from the on-disk catalog cache (populated by the
  // /models picker's providers_list fetch) or the build-time snapshot, with
  // config model overrides merged on top. The turn path never fetches.
  let mergedCatalog: ModelInfo[] | undefined;
  const ensureCatalog = (): ModelInfo[] => {
    if (!mergedCatalog) {
      mergedCatalog = mergeCatalogWithConfig(
        loadCachedCatalog(join(dataDir(), "cache"))?.models ?? BUILTIN_MODELS,
        providers,
      );
    }
    return mergedCatalog;
  };
  const catalogModel = (provider: string, model: string): ModelInfo | undefined => {
    return ensureCatalog().find((m) => m.id === model && m.family === provider);
  };
  /**
   * Resolves an agent's model when it's not explicitly set:
   * 1. Use global config.model if its provider matches the agent's provider.
   * 2. Fall back to the first catalog model for that provider.
   * 3. Return empty string (dispatch will fail with a clear error).
   */
  const resolveAgentModel = (provider: string, model?: string): string => {
    if (model) return model;
    const ref = parseModelRef(config.model ?? "");
    if (ref && ref.provider === provider) return ref.model;
    const first = ensureCatalog().find((m) => m.family === provider);
    return first?.id ?? "";
  };

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
  // latest one — so todos survive daemon restarts and compaction.
  const todoSessionsDir = options.sessionsDir ?? storagePaths(options.workspaceRoot).sessionsDir;
  const todoStore = new SessionStore(todoSessionsDir, { bus: eventBus, logger });
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
    sharedPluginTools = sharedPluginRegistry.list() as unknown as ToolSpec[];
  } else {
    tools = options.tools ?? [];
    const { ToolRegistry } = await import("@agency/tools");
    const pluginToolRegistry = new ToolRegistry();
    for (const t of tools) pluginToolRegistry.register(t as unknown as import("@agency/tools").ToolSpec);
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
    tools = pluginToolRegistry.list() as unknown as ToolSpec[];
  }

  const taskMaxDepth = (config as unknown as { task?: { maxDepth?: number } }).task?.maxDepth ?? 1;

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
        mcpServers: config.mcpServers,
        lspServers: config.lspServers,
        identityFor: (_serverName, h) => ({ type: "agent", name: h ?? handle ?? "main" }),
      });
      for (const t of sharedPluginTools) {
        try {
          scope.registry.register(t as unknown as import("@agency/tools").ToolSpec);
        } catch {}
      }
      try {
        const taskTool = createTaskTool({
          maxDepth: taskMaxDepth,
          runTask: async (input, ctx) => {
            const parentTurnId = ctx.turnId;
            const parentSessionId = ctx.sessionId ?? "default";
            const meta = parentTurnId ? activeTurnMeta.get(parentTurnId) : undefined;
            const parentDepth = ctx.taskDepth ?? meta?.taskDepth ?? 0;
            const parentProvider = meta?.provider ?? "anthropic";
            const parentModel = meta?.model ?? "test-model";
            const parentApiKey = meta?.apiKey ?? "";
            const parentCaps = meta?.capabilities ?? { tools: "*", pathScopes: "*", network: "*" as const };
            const parentTools = meta?.tools ?? (scope.registry.list() as unknown as ToolSpec[]);

            let childProvider = parentProvider;
            let childModel = parentModel;
            if (typeof input.model === "string" && input.model.length > 0) {
              const slash = input.model.indexOf("/");
              if (slash > 0) {
                childProvider = input.model.slice(0, slash);
                childModel = input.model.slice(slash + 1);
              } else {
                childModel = input.model;
              }
            }

            let childApiKey = parentApiKey;
            if (childProvider !== parentProvider) {
              try {
                const kc = await getKeychain();
                const k = await resolveApiKey({
                  provider: childProvider,
                  env: process.env,
                  keychain: kc,
                  config: providers[childProvider]?.apiKey,
                  ...oauthOverridesFor(childProvider, providers),
                });
                if (k) {
                  childApiKey = k;
                  redactor.registerSecret(k);
                }
              } catch {}
            }

            const childSessionId = newEntryId();
            const childTurnId = newEntryId();
            const startMs = Date.now();
            try {
              todoStore.create(childSessionId);
            } catch {}
            await getOrCreateScope(childSessionId);

            const baseTools = parentTools;
            let childTools: ToolSpec[];
            if (Array.isArray(input.tools) && input.tools.length > 0) {
              const allow = new Set(input.tools);
              childTools = baseTools.filter((t) => allow.has(t.name));
              if (!allow.has("task") && childTools.some((t) => t.name === "task")) {
                childTools = childTools.filter((t) => t.name !== "task");
              }
            } else {
              childTools = baseTools.filter((t) => gate.toolOffered(t.name, t.riskTier as never));
            }
            // Depth-0 child isolation: subagents cannot dispatch or spawn tasks.
            childTools = childTools.filter((t) => t.name !== "dispatch" && t.name !== "task");

            const childCapTools = childTools.map((t) => t.name);
            const childCaps: Capabilities = {
              tools: childCapTools.length > 0 ? childCapTools : ("*" as const),
              pathScopes: parentCaps.pathScopes,
              network: parentCaps.network,
            };

            const workerPrompt = composeSystemPrompt({
              base: "You are a task worker. Complete the given prompt concisely and return only the final result.",
              instructions: [],
              toolDescriptions: [],
            }).text;

            const freshSession: Message[] = [
              { role: "user", content: [{ type: "text", text: input.prompt }] },
            ];

            const childModelInfo = catalogModel(childProvider, childModel);
            const childTraceRecorder = (() => {
              try {
                return new TraceRecorder({
                  sessionsDir: todoSessionsDir,
                  sessionId: childSessionId,
                  traceId: childTurnId,
                  provider: childProvider,
                  model: childModel,
                  redactor,
                });
              } catch {
                return undefined;
              }
            })();
            const childEvents: LoopEvent[] = [];
            const adapter = adapterFor(childProvider);
            const scheduler = schedulerFor(childProvider);
            const childBudget = meta?.budget;

            let childResult: Awaited<ReturnType<typeof runTurn>> | undefined;
            let childError: unknown;
            try {
              childResult = await runTurn(adapter, scheduler, http, {
                identity,
                capabilities: childCaps,
                toolPolicy: gate,
                eventBus,
                systemPrompt: workerPrompt,
                tools: childTools as unknown as import("@agency/core").ToolSpec[],
                model: childModel,
                apiKey: childApiKey,
                provider: childProvider,
                traceRecorder: childTraceRecorder,
                session: freshSession,
                budget: childBudget,
                pricePerMTok: childModelInfo
                  ? {
                      input: childModelInfo.pricing.inputPerMTok,
                      output: childModelInfo.pricing.outputPerMTok,
                    }
                  : undefined,
                maxTokensPerRequest: childModelInfo?.maxOutputTokens,
                turnId: childTurnId,
                sessionId: childSessionId,
                cwd: options.workspaceRoot,
                taskDepth: parentDepth + 1,
                doomLoopDetection: true,
                signal: ctx.signal,
                onEvent: (ev) => {
                  childEvents.push(ev);
                },
              });
            } catch (e) {
              childError = e;
            }
            {
              const durationMs = Date.now() - startMs;
              const finalText = childResult ? extractFinalText(childResult.messages) : "";
              const collapsed =
                (finalText || (childError instanceof Error ? childError.message : String(childError ?? "")))
                  .split("\n")[0]
                  ?.slice(0, 500) ?? "";
              try {
                const parentLatestTip = todoStore.latestTip(todoStore.load(parentSessionId)) ?? null;
                await todoStore.append(parentSessionId, {
                  type: "task_result",
                  parentId: parentLatestTip,
                  tool: "task",
                  childSessionId,
                  childTurnId,
                  durationMs,
                  summary: collapsed || finalText.slice(0, 500),
                  prompt: input.prompt.slice(0, 200),
                });
              } catch {}
              try {
                if (childResult) {
                  let childParentId: string | null = null;
                  const msgs = childResult.messages;
                  for (const msg of msgs) {
                    const appended = await todoStore.append(childSessionId, {
                      type: "message",
                      parentId: childParentId,
                      message: msg,
                    });
                    childParentId = appended.id;
                  }
                }
              } catch {}
              try {
                if (childTraceRecorder && childResult) {
                  const rec = childTraceRecorder.toCassetteRecord(
                    {
                      provider: childProvider,
                      model: childModel,
                      systemPrompt: workerPrompt,
                      session: freshSession,
                    },
                    childEvents,
                    childResult,
                  );
                  void childTraceRecorder.writeCassette(childTurnId, rec);
                }
              } catch {}
              try {
                const cs = sessionScopes.get(childSessionId);
                if (cs) {
                  try {
                    await cs.dispose();
                  } catch {}
                  sessionScopes.delete(childSessionId);
                }
              } catch {}
            }

            if (childError) {
              return {
                content: childError instanceof Error ? childError.message : String(childError),
                isError: true,
              };
            }
            const finalText = extractFinalText(childResult?.messages ?? []);
            return { content: finalText || "(no output)" };
          },
        });
        if (!scope.registry.has("task"))
          scope.registry.register(taskTool as unknown as import("@agency/tools").ToolSpec);
        try {
          const cfgAgents = (config as unknown as { agents?: Record<string, unknown> }).agents;
          const hasOrchestra = cfgAgents && Object.keys(cfgAgents).length > 1;
          if (hasOrchestra && !scope.registry.has("dispatch")) {
            const dispatchTool = createDispatchTool({
              dispatch: async (input, ctx) => {
                if (orchestraRegistry.list().length === 0) {
                  return {
                    content: "no agents enabled: enable at least one agent (leader is required)",
                    isError: true,
                  };
                }

                // Hard budget caps: throw before spawning any peer.
                const budgets = (config as unknown as { budgets?: OrchestraBudgets }).budgets;
                try {
                  checkOrchestraBudgets({
                    budgets,
                    perAgentSpend: new Map(input.agents.map((a) => [a.handle, costUsdForHandle(a.handle)])),
                    orchestraTotal: orchestraTotalCost,
                    handles: input.agents.map((a) => a.handle),
                  });
                } catch (error) {
                  return { content: error instanceof Error ? error.message : String(error), isError: true };
                }
                const forecastThreshold = config.sandbox?.forecastCostUsd;
                if (forecastThreshold !== undefined) {
                  const forecastAgents: DispatchAgentForecast[] = input.agents.map((a) => {
                    const agent = orchestraRegistry.get(a.handle);
                    const modelId = agent?.model ?? resolveAgentModel(agent?.provider ?? "", "");
                    const modelInfo = agent ? catalogModel(agent.provider, modelId) : undefined;
                    return {
                      model: modelId || "unknown",
                      inputPerMTok: modelInfo?.pricing.inputPerMTok ?? 0,
                      outputPerMTok: modelInfo?.pricing.outputPerMTok ?? 0,
                      effort: a.effort ?? agent?.effort,
                    };
                  });
                  const estimate = estimateDispatchCost({
                    briefChars: input.agents.reduce((sum, a) => sum + a.brief.length, 0),
                    agents: forecastAgents,
                  });
                  try {
                    await checkCostForecast({
                      estimate,
                      thresholdUsd: forecastThreshold,
                      ask: ctx.requestApproval,
                    });
                  } catch (error) {
                    return { content: error instanceof Error ? error.message : String(error), isError: true };
                  }
                }

                // Parallel specialist spawn (item 52): every specialist is
                // spawned concurrently via a run_in_background-like spawn and
                // joined on a single promise barrier. Results keep input order
                // via index slots; each child gets only a lean brief slice and
                // the parent keeps only one-line summaries (lean context).
                const barrierNotify = (settled: Array<{ index: number; ok: boolean }>): void => {
                  try {
                    eventBus.emit("dispatch.complete", {
                      count: settled.length,
                      ok: settled.filter((s) => s.ok).length,
                    });
                  } catch {}
                  try {
                    broadcast(`orchestra.shared`, { type: "dispatch_complete", count: settled.length });
                  } catch {}
                  // Back-compat dual-publish to swarm.* channels
                  try {
                    broadcast(`swarm.shared`, { type: "dispatch_complete", count: settled.length });
                  } catch {}
                };
                const dispatchBarrier = new PromiseBarrier<string>(input.agents.length, barrierNotify);
                const batchScheduler = new Scheduler({ maxConcurrent: Math.max(8, input.agents.length) });
                try {
                  broadcast(`orchestra.shared`, {
                    type: "dispatch_start",
                    count: input.agents.length,
                    handles: input.agents.map((a) => a.handle),
                  });
                } catch {}
                // Back-compat dual-publish to swarm.* channels
                try {
                  broadcast(`swarm.shared`, {
                    type: "dispatch_start",
                    count: input.agents.length,
                    handles: input.agents.map((a) => a.handle),
                  });
                } catch {}
                const dispatchTasks = input.agents.map((a, slot) =>
                  (async () => {
                    const agent = orchestraRegistry.get(a.handle);
                    if (!agent) {
                      dispatchBarrier.complete(slot, `${a.handle}: unknown handle`);
                      return;
                    }
                    // Budget caps are checked before spawning: nothing starts once
                    // the orchestra total or this agent's session spend hits its cap.
                    const dispatchBudgets = (
                      config as unknown as { budgets?: { perAgentUsd?: number; orchestraUsd?: number } }
                    ).budgets;
                    if (
                      dispatchBudgets?.orchestraUsd !== undefined &&
                      orchestraTotalCost >= dispatchBudgets.orchestraUsd
                    ) {
                      dispatchBarrier.complete(
                        slot,
                        `${a.handle}: orchestra budget exceeded: ${orchestraTotalCost} >= ${dispatchBudgets.orchestraUsd}`,
                      );
                      return;
                    }
                    const spentForAgent = orchestraCost.get(agent.sessionId) ?? 0;
                    if (
                      dispatchBudgets?.perAgentUsd !== undefined &&
                      spentForAgent >= dispatchBudgets.perAgentUsd
                    ) {
                      dispatchBarrier.complete(
                        slot,
                        `${a.handle}: budget exceeded: per-agent ${spentForAgent} >= ${dispatchBudgets.perAgentUsd}`,
                      );
                      return;
                    }
                    const effort =
                      a.effort ?? (agent.effort === "auto" ? classifyEffortFromText(a.brief) : agent.effort);
                    const childSessionId = agent.sessionId;
                    try {
                      todoStore.create(childSessionId);
                    } catch {
                      /* best-effort: session may already exist */
                    }
                    try {
                      eventBus.emit("subagent.start", {
                        sessionId: childSessionId,
                        handle: a.handle,
                        parentSessionId: sessionId,
                      });
                      eventBus.emit("event", {
                        event: "subagent.start",
                        payload: { sessionId: childSessionId, handle: a.handle, parentSessionId: sessionId },
                      });
                    } catch {}
                    await getOrCreateScope(childSessionId, a.handle);
                    const caps = agent.capabilities;
                    const writeCapable = caps
                      ? caps.some((c) => ["write", "edit", "bash"].includes(c))
                      : true;
                    if (writeCapable) {
                      const wtPath = join(options.workspaceRoot, ".agency", "worktrees", a.handle);
                      try {
                        await createWorktree(options.workspaceRoot, wtPath);
                        const sc = sessionScopes.get(childSessionId);
                        if (isReadOnlyAgent(a.handle)) {
                          const scratchDir = join(".agency", "scratch", a.handle);
                          const scratchAbs = makeWorktreeReadOnly(wtPath, scratchDir);
                          if (sc) sc.bashState.cwd = scratchAbs;
                        } else {
                          if (sc) sc.bashState.cwd = wtPath;
                        }
                      } catch {
                        const sc = sessionScopes.get(childSessionId);
                        if (sc) sc.bashState.cwd = options.workspaceRoot;
                      }
                    }
                    const tip = todoStore.latestTip(todoStore.load(childSessionId)) ?? null;
                    await todoStore
                      .append(childSessionId, {
                        type: "agent_lifecycle",
                        parentId: tip,
                        handle: a.handle,
                        state: "working",
                        detail: a.brief,
                      })
                      .catch(() => {
                        /* best-effort lifecycle persistence */
                      });
                    agentStates.set(a.handle, "working");
                    try {
                      eventBus.emit("agent.lifecycle", { handle: a.handle, state: "working" });
                    } catch {}
                    if (orchestraRegistry.list().length > 1) {
                      try {
                        broadcast(`orchestra.${childSessionId}`, {
                          type: "agent_lifecycle",
                          handle: a.handle,
                          state: "working",
                          detail: a.brief.slice(0, 200),
                          sessionId: childSessionId,
                        });
                      } catch {}
                      try {
                        broadcast(`orchestra.shared`, {
                          type: "agent_lifecycle",
                          handle: a.handle,
                          state: "working",
                          detail: a.brief.slice(0, 200),
                          sessionId: childSessionId,
                        });
                      } catch {}
                      // Back-compat dual-publish to swarm.* channels
                      try {
                        broadcast(`swarm.${childSessionId}`, {
                          type: "agent_lifecycle",
                          handle: a.handle,
                          state: "working",
                          detail: a.brief.slice(0, 200),
                          sessionId: childSessionId,
                        });
                      } catch {}
                      try {
                        broadcast(`swarm.shared`, {
                          type: "agent_lifecycle",
                          handle: a.handle,
                          state: "working",
                          detail: a.brief.slice(0, 200),
                          sessionId: childSessionId,
                        });
                      } catch {}
                    }

                    // --- Real turn execution (following task tool pattern at line 628) ---
                    const childProvider = agent.provider;
                    const childModel = agent.model ?? "";

                    let childApiKey = "";
                    try {
                      const kc = await getKeychain();
                      const k = await resolveApiKey({
                        provider: childProvider,
                        env: process.env,
                        keychain: kc,
                        config: providers[childProvider]?.apiKey,
                        ...oauthOverridesFor(childProvider, providers),
                      });
                      if (k) {
                        childApiKey = k;
                        redactor.registerSecret(k);
                      }
                    } catch {}

                    const childModelInfo = catalogModel(childProvider, childModel);
                    const childTurnId = newEntryId();
                    const startMs = Date.now();

                    const childTraceRecorder = (() => {
                      try {
                        return new TraceRecorder({
                          sessionsDir: todoSessionsDir,
                          sessionId: childSessionId,
                          traceId: childTurnId,
                          provider: childProvider,
                          model: childModel,
                          redactor,
                        });
                      } catch {
                        return undefined;
                      }
                    })();

                    const childEvents: LoopEvent[] = [];
                    const adapter = adapterFor(childProvider);
                    const scheduler = batchScheduler;

                    const freshSession: Message[] = [
                      { role: "user", content: [{ type: "text", text: leanBrief(a.brief) }] },
                    ];

                    const childScope = sessionScopes.get(childSessionId);
                    const childTools = childScope?.tools ?? [];
                    const agentGate = gateForAgent(a.handle);
                    const offeredTools = childTools
                      .filter((t) => agentGate.toolOffered(t.name, t.riskTier))
                      // Depth-0 child isolation: subagents cannot dispatch or spawn tasks.
                      .filter((t) => t.name !== "dispatch" && t.name !== "task");
                    const agentCaps = capabilitiesForAgent(agentGate, childTools);

                    const agentSystemPrompt = composeSystemPrompt({
                      base: `You are ${a.handle}, a ${agent.role} agent. Complete the given brief concisely.`,
                      familyPresetOverlay: undefined,
                      instructions: [],
                      toolDescriptions: [],
                      context: buildEnvironmentBlock(gatherEnvironmentInfo({ cwd: options.workspaceRoot })),
                    });

                    let childResult: Awaited<ReturnType<typeof runTurn>> | undefined;
                    let childError: unknown;
                    try {
                      childResult = await runTurn(adapter, scheduler, http, {
                        identity: { type: "agent", name: a.handle },
                        capabilities: agentCaps,
                        toolPolicy: agentGate,
                        eventBus,
                        systemPrompt: agentSystemPrompt.text,
                        tools: offeredTools as unknown as import("@agency/core").ToolSpec[],
                        model: childModel,
                        apiKey: childApiKey,
                        provider: childProvider,
                        traceRecorder: childTraceRecorder,
                        session: freshSession,
                        pricePerMTok: childModelInfo
                          ? {
                              input: childModelInfo.pricing.inputPerMTok,
                              output: childModelInfo.pricing.outputPerMTok,
                            }
                          : undefined,
                        maxTokensPerRequest: childModelInfo?.maxOutputTokens,
                        turnId: childTurnId,
                        sessionId: childSessionId,
                        cwd: options.workspaceRoot,
                        taskDepth: ctx.taskDepth + 1,
                        doomLoopDetection: true,
                        signal: ctx.signal,
                        drainMailbox: () => {
                          const msgs: import("@agency/schema").Message[] = [];
                          const box = agentMailboxes.get(a.handle);
                          if (box && box.length > 0) {
                            msgs.push(...box);
                            box.length = 0;
                          }
                          const reg = orchestraRegistry.get(a.handle)?.mailbox;
                          if (reg && reg.length > 0) {
                            msgs.push(...reg);
                            reg.length = 0;
                          }
                          return msgs;
                        },
                        onEvent: (ev) => {
                          childEvents.push(ev);
                        },
                      });
                    } catch (e) {
                      childError = e;
                    }

                    // Persist result as task_result entry
                    const durationMs = Date.now() - startMs;
                    const finalText = childResult ? extractFinalText(childResult.messages) : "";
                    const collapsed = leanSummary(
                      finalText ||
                        (childError instanceof Error ? childError.message : String(childError ?? "")),
                    );
                    try {
                      const parentLatestTip = todoStore.latestTip(todoStore.load(childSessionId)) ?? null;
                      await todoStore.append(childSessionId, {
                        type: "task_result",
                        parentId: parentLatestTip,
                        tool: "dispatch",
                        childSessionId,
                        childTurnId,
                        durationMs,
                        summary: collapsed || leanSummary(finalText),
                        prompt: leanPrompt(a.brief),
                      });
                    } catch {}

                    if (childError) {
                      agentStates.set(a.handle, "failed");
                      try {
                        const tip2 = todoStore.latestTip(todoStore.load(childSessionId)) ?? null;
                        await todoStore
                          .append(childSessionId, {
                            type: "agent_lifecycle",
                            parentId: tip2,
                            handle: a.handle,
                            state: "failed",
                            detail: childError instanceof Error ? childError.message : String(childError),
                          })
                          .catch(() => {
                            /* best-effort lifecycle persistence */
                          });
                      } catch {}
                      if (orchestraRegistry.list().length > 1) {
                        try {
                          broadcast(`orchestra.${childSessionId}`, {
                            type: "agent_lifecycle",
                            handle: a.handle,
                            state: "failed",
                          });
                        } catch {}
                        try {
                          broadcast(`orchestra.shared`, {
                            type: "agent_lifecycle",
                            handle: a.handle,
                            state: "failed",
                          });
                        } catch {}
                        // Back-compat dual-publish to swarm.* channels
                        try {
                          broadcast(`swarm.${childSessionId}`, {
                            type: "agent_lifecycle",
                            handle: a.handle,
                            state: "failed",
                          });
                        } catch {}
                        try {
                          broadcast(`swarm.shared`, {
                            type: "agent_lifecycle",
                            handle: a.handle,
                            state: "failed",
                          });
                        } catch {}
                      }
                      dispatchBarrier.complete(
                        slot,
                        `${a.handle}: ${childError instanceof Error ? childError.message : String(childError)}`,
                      );
                    } else {
                      agentStates.set(a.handle, "idle");
                      try {
                        const tip2 = todoStore.latestTip(todoStore.load(childSessionId)) ?? null;
                        await todoStore
                          .append(childSessionId, {
                            type: "agent_lifecycle",
                            parentId: tip2,
                            handle: a.handle,
                            state: "idle",
                            detail: "dispatch done",
                          })
                          .catch(() => {
                            /* best-effort lifecycle persistence */
                          });
                      } catch {}
                      if (childResult && childModelInfo) {
                        const costUsd =
                          (childResult.usage.inputTokens / 1_000_000) * childModelInfo.pricing.inputPerMTok +
                          (childResult.usage.outputTokens / 1_000_000) * childModelInfo.pricing.outputPerMTok;
                        orchestraCost.set(childSessionId, (orchestraCost.get(childSessionId) ?? 0) + costUsd);
                        orchestraTotalCost += costUsd;
                      }
                      if (orchestraRegistry.list().length > 1) {
                        try {
                          broadcast(`orchestra.${childSessionId}`, {
                            type: "agent_lifecycle",
                            handle: a.handle,
                            state: "idle",
                          });
                        } catch {}
                        try {
                          broadcast(`orchestra.shared`, {
                            type: "agent_lifecycle",
                            handle: a.handle,
                            state: "idle",
                          });
                        } catch {}
                        // Back-compat dual-publish to swarm.* channels
                        try {
                          broadcast(`swarm.${childSessionId}`, {
                            type: "agent_lifecycle",
                            handle: a.handle,
                            state: "idle",
                          });
                        } catch {}
                        try {
                          broadcast(`swarm.shared`, {
                            type: "agent_lifecycle",
                            handle: a.handle,
                            state: "idle",
                          });
                        } catch {}
                      }
                      dispatchBarrier.complete(
                        slot,
                        `${a.handle} dispatched at ${effort}: ${leanSummary(finalText, 80) || "(no output)"}`,
                      );
                    }
                  })().catch((error: unknown) => {
                    dispatchBarrier.fail(slot, error);
                  }),
                );
                await Promise.all(dispatchTasks);
                const dispatchSettled = await dispatchBarrier.wait();
                const lines = dispatchSettled.map((s) =>
                  s.ok
                    ? (s.value as string)
                    : `${input.agents[s.index]?.handle ?? s.index}: ${s.error instanceof Error ? s.error.message : String(s.error)}`,
                );
                return { content: lines.join("\n") };
              },
            });
            scope.registry.register(dispatchTool as unknown as import("@agency/tools").ToolSpec);
          }
        } catch {}
      } catch {}
      (scope as { tools: ToolSpec[] }).tools = scope.registry.list() as unknown as ToolSpec[];
      const ownerHandle = orchestraRegistry.list().find((a) => a.sessionId === sessionId)?.handle;
      if (ownerHandle) {
        const ownerGate = gateForAgent(ownerHandle);
        if (ownerGate !== gate) {
          (scope as { tools: ToolSpec[] }).tools = (scope as unknown as { tools: ToolSpec[] }).tools.filter(
            (t) => ownerGate.toolOffered(t.name, t.riskTier),
          );
        }
      }
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

  function sessionToolsFor(list: ToolSpec[], offerGate: PermissionsGate = gate): readonly string[] | "*" {
    const offered = list.filter((t) => offerGate.toolOffered(t.name, t.riskTier));
    return offered.length === list.length ? ("*" as const) : offered.map((t) => t.name);
  }

  function gateForSession(sessionId: string): PermissionsGate {
    const ownerHandle = orchestraRegistry.list().find((a) => a.sessionId === sessionId)?.handle;
    return ownerHandle ? gateForAgent(ownerHandle) : gate;
  }

  const commands = loadCommands({
    workspaceRoot: options.workspaceRoot,
    configDirOverride: options.configDir,
  });

  const globalDefaultCapabilities: Capabilities | undefined = options.capabilities;
  async function defaultCapabilitiesForSession(sessionId?: string): Promise<Capabilities> {
    if (globalDefaultCapabilities) return globalDefaultCapabilities;
    if (!builtinsMode) {
      return { tools: sessionToolsFor(tools), pathScopes: "*", network: "*" };
    }
    const sid = sessionId ?? "default";
    const sessionGate = gateForSession(sid);
    const cached = sessionScopes.get(sid);
    if (cached) return { tools: sessionToolsFor(cached.tools, sessionGate), pathScopes: "*", network: "*" };
    try {
      const scope = await getOrCreateScope(sid);
      return { tools: sessionToolsFor(scope.tools, sessionGate), pathScopes: "*", network: "*" };
    } catch {
      return { tools: "*", pathScopes: "*", network: "*" };
    }
  }
  const defaultCapabilitiesSync: Capabilities =
    options.capabilities ??
    (builtinsMode
      ? { tools: "*", pathScopes: "*", network: "*" }
      : { tools: sessionToolsFor(tools), pathScopes: "*", network: "*" });

  const orchestraRegistry = new AgentRegistry();
  const orchestraTodo: OrchestraTodoStore = new OrchestraTodoStore({
    persist: async (todos) => {
      try {
        const sid = "orchestra-shared";
        const entries = todoStore.load(sid);
        await todoStore.append(sid, {
          type: "todo_state",
          parentId: todoStore.latestTip(entries) ?? null,
          todos,
        });
      } catch {}
    },
  });
  const orchestraCost = new Map<string, number>();
  let orchestraTotalCost = 0;
  const agentMailboxes = new Map<string, import("@agency/schema").Message[]>();
  const agentStates = new Map<string, "idle" | "working" | "blocked" | "failed">();

  const initOrchestraFromConfig = () => {
    const cfg = config as unknown as {
      agents?: Record<
        string,
        { role: string; provider?: string; model?: string; effort?: string; enabled?: boolean }
      >;
      leader?: string;
    };
    if (!cfg.agents) return;
    for (const [handle, a] of Object.entries(cfg.agents)) {
      // Skip disabled agents — they are not registered in the orchestra
      if (a.enabled === false) continue;
      // Skip enabled agents that are missing required fields
      if (!a.provider) {
        logger.warn(
          `agent "${handle}" is enabled but missing provider — configure provider/model/effort before use`,
        );
        continue;
      }
      if (!a.effort) {
        logger.warn(
          `agent "${handle}" is enabled but missing effort — configure provider/model/effort before use`,
        );
        continue;
      }
      if (!orchestraRegistry.has(handle)) {
        const resolvedModel = resolveAgentModel(a.provider, a.model);
        const modelInfo = catalogModel(a.provider, resolvedModel);
        const clampedEffort = clampEffortForModel(
          a.effort as import("@agency/providers").EffortLevel,
          modelInfo,
        );
        orchestraRegistry.register({
          handle,
          role: a.role,
          provider: a.provider,
          model: resolvedModel,
          effort: clampedEffort,
          sessionId: `orchestra-${handle}`,
          mailbox: [],
        });
        agentMailboxes.set(handle, []);
        agentStates.set(handle, "idle");
      }
    }
    // Enforce leader must be enabled
    if (!orchestraRegistry.has("leader")) {
      logger.warn("leader agent is disabled or missing — leader must be enabled for orchestra operations");
    }
    // Enforce at least one enabled agent
    if (orchestraRegistry.list().length === 0) {
      logger.warn("no agents enabled: enable at least one agent (leader is required)");
    }
  };
  try {
    initOrchestraFromConfig();
  } catch {}

  function costUsdForHandle(handle: string): number {
    const agent = orchestraRegistry.get(handle);
    if (!agent) return 0;
    let traced = 0;
    try {
      const spans = loadTraceSpansSync(todoSessionsDir, agent.sessionId);
      traced = spans.filter((s) => s.kind === "model").reduce((sum, s) => sum + (s.attributes.cost ?? 0), 0);
    } catch {}
    return Math.max(traced, orchestraCost.get(agent.sessionId) ?? 0);
  }

  function agentsListPayload(): Array<{
    handle: string;
    role: string;
    provider: string;
    model: string;
    effort: string;
    state: string;
    sessionId: string;
    costUsd: number;
  }> {
    return orchestraRegistry.list().map((a) => ({
      handle: a.handle,
      role: a.role,
      provider: a.provider,
      model: a.model ?? "",
      effort: a.effort,
      state: agentStates.get(a.handle) ?? "idle",
      sessionId: a.sessionId,
      costUsd: costUsdForHandle(a.handle),
    }));
  }

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
  const turnOwners = new Map<string, string>();
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  let server!: DaemonServer;
  let httpGateway!: HttpGatewayServer;

  // Standalone handler functions for orchestra RPC (also referenced by swarm_* aliases)
  const orchestraStatusHandler = async () => {
    const agents = agentsListPayload();
    const todo = orchestraTodo.list();
    const costTotal = agents.reduce((sum, a) => sum + (a.costUsd ?? 0), 0);
    return { agents, todo, costTotal };
  };
  const orchestraStopHandler = async (rawParams: unknown) => {
    const { sessionId } = (rawParams ?? {}) as { sessionId?: string };
    const sid = sessionId ?? "default";
    for (const ctrl of activeControllers.values())
      try {
        ctrl.abort();
      } catch {}
    try {
      const tip = todoStore.latestTip(todoStore.load(sid)) ?? null;
      for (const h of orchestraRegistry.list().map((a) => a.handle)) {
        await todoStore
          .append(sid, {
            type: "agent_lifecycle",
            parentId: tip,
            handle: h,
            state: "idle",
            detail: "orchestra_stop",
          })
          .catch(() => {});
        agentStates.set(h, "idle");
        if (orchestraRegistry.list().length > 1) {
          const agent = orchestraRegistry.get(h);
          const stream = agent ? `orchestra.${agent.sessionId}` : `orchestra.${sid}`;
          try {
            broadcast(stream, { type: "agent_lifecycle", handle: h, state: "idle" });
          } catch {}
          try {
            broadcast(`orchestra.shared`, { type: "agent_lifecycle", handle: h, state: "idle" });
          } catch {}
          // Back-compat dual-publish to swarm.* channels
          const swarmStream = agent ? `swarm.${agent.sessionId}` : `swarm.${sid}`;
          try {
            broadcast(swarmStream, { type: "agent_lifecycle", handle: h, state: "idle" });
          } catch {}
          try {
            broadcast(`swarm.shared`, { type: "agent_lifecycle", handle: h, state: "idle" });
          } catch {}
        }
      }
    } catch {}
    return { stopped: true };
  };

  const handlers: Record<string, import("@agency/rpc").MethodHandler> = {
    async run_turn(rawParams, context) {
      const params = rawParams as RunTurnParams;
      const controller = new AbortController();
      activeControllers.set(params.turnId, controller);
      turnOwners.set(params.turnId, context.clientId);
      const eventStream = `turn.${params.turnId}`;

      // R10 wiring: the whole turn — provider requests and tool calls —
      // correlates under one trace ID in the logs.
      return withTrace(async () => {
        if (configFingerprint.check()) {
          logger.warn("config changed — restart daemon to apply");
        }
        // Turn heartbeats keep heartbeat-aware clients' deadlines alive
        // through silent stretches (a long tool call emits no deltas).
        const turnHeartbeat = setInterval(() => {
          broadcast(eventStream, { type: "heartbeat" });
        }, HEARTBEAT_INTERVAL_MS);
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
                ...oauthOverridesFor(params.provider, providers),
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
          const sessionId = params.sessionId ?? "default";
          const tracePromptVersion =
            params.promptVersion ??
            (params.systemPromptParts?.identity || params.systemPromptParts?.role
              ? `${params.systemPromptParts?.identity ?? ""}|${params.systemPromptParts?.role ?? ""}`.slice(
                  0,
                  200,
                )
              : undefined);
          let traceRecorder: TraceRecorder | undefined;
          const collectedTraceEvents: LoopEvent[] = [];
          try {
            traceRecorder = new TraceRecorder({
              sessionsDir: todoSessionsDir,
              sessionId,
              traceId: params.turnId,
              promptVersion: tracePromptVersion,
              provider: params.provider,
              model: params.model,
              redactor,
            });
          } catch {}
          let resolvedProvider = params.provider;
          let resolvedModel = params.model;
          let resolvedThinkingLevel = params.thinkingLevel as string | undefined;
          const lastUserText = (() => {
            const m = params.session[params.session.length - 1];
            const b = m?.content?.find((c: { type: string }) => c.type === "text") as
              | { text?: string }
              | undefined;
            return typeof b?.text === "string" ? b.text : "";
          })();
          const mentioned = parseHandles(lastUserText).filter((h) => orchestraRegistry.has(h));
          if (mentioned.length === 1) {
            const handle = mentioned.at(0);
            const agent = handle !== undefined ? orchestraRegistry.get(handle) : undefined;
            if (agent) {
              resolvedProvider = agent.provider;
              resolvedModel = agent.model ?? "";
              if (agent.effort === "auto" && !resolvedThinkingLevel) {
                // Directly-addressed agent with auto effort (no dispatcher):
                // traced small-model classification, keyword heuristic fallback.
                resolvedThinkingLevel = await classifyEffortWithSmallModel(lastUserText, {
                  config: config as Record<string, unknown>,
                  adapterFor,
                  http,
                  apiKey,
                  providers: providers as Record<
                    string,
                    { apiKey?: string; family?: string; baseUrl?: string }
                  >,
                  traceRecorder,
                });
              }
            }
          } else if (mentioned.length === 0 && params.thinkingLevel === undefined) {
            const cfgAgents = (config as unknown as { agents?: Record<string, { effort: string }> }).agents;
            const leaderHandle =
              (config as unknown as { leader?: string }).leader ??
              (cfgAgents ? Object.keys(cfgAgents)[0] : undefined);
            const leaderEffort = leaderHandle ? cfgAgents?.[leaderHandle]?.effort : undefined;
            if (leaderEffort === "auto") {
              // Leader case (no dispatcher): use small-model classification
              // instead of keyword heuristic
              resolvedThinkingLevel = await classifyEffortWithSmallModel(lastUserText, {
                config: config as Record<string, unknown>,
                adapterFor,
                http,
                apiKey,
                providers: providers as Record<
                  string,
                  { apiKey?: string; family?: string; baseUrl?: string }
                >,
                traceRecorder,
              });
            }
          }
          const budgets = (config as unknown as { budgets?: OrchestraBudgets }).budgets;
          const perAgentBudget = budgets?.perAgentUsd;
          const orchestraBudget = budgets?.orchestraUsd;
          if (perAgentBudget !== undefined) {
            const agentForSession = orchestraRegistry
              .list()
              .find((a) => a.sessionId === (params.sessionId ?? "default"));
            const spent = agentForSession
              ? costUsdForHandle(agentForSession.handle)
              : (orchestraCost.get(params.sessionId ?? "default") ?? 0);
            if (spent >= perAgentBudget)
              throw new Error(`budget exceeded: per-agent ${spent} >= ${perAgentBudget}`);
          }
          if (orchestraBudget !== undefined && orchestraTotalCost >= orchestraBudget)
            throw new Error(`orchestra budget exceeded: ${orchestraTotalCost} >= ${orchestraBudget}`);

          const modelInfo = catalogModel(resolvedProvider, resolvedModel);
          // Clamp the resolved thinking level to what the model actually supports
          if (resolvedThinkingLevel && modelInfo) {
            resolvedThinkingLevel = clampEffortForModel(
              resolvedThinkingLevel as import("@agency/providers").EffortLevel,
              modelInfo,
            );
          }
          const wrappedOnEvent = (event: LoopEvent): void => {
            collectedTraceEvents.push(event);
            broadcast(eventStream, event);
          };
          const isNewSession = todoStore.load(sessionId).length === 0 && params.session.length > 0;
          if (isNewSession) {
            try {
              eventBus.emit("session.created", { sessionId });
              eventBus.emit("session.start", { sessionId, workspaceRoot: options.workspaceRoot });
              eventBus.emit("event", { event: "session.created", payload: { sessionId } });
              eventBus.emit("event", {
                event: "session.start",
                payload: { sessionId, workspaceRoot: options.workspaceRoot },
              });
            } catch {}
          }
          if (params.session.length > 0) {
            const lastMsg = params.session[params.session.length - 1];
            const lastText = lastMsg?.content?.find((b: { type: string }) => b.type === "text") as
              | { text?: string }
              | undefined;
            const text = typeof lastText?.text === "string" ? lastText.text.trim() : "";
            const parsed = parseSlashInput(text);
            if (parsed) {
              const tmpl = commands.find((c) => c.name === parsed.name);
              if (tmpl) {
                const expanded = expandCommand(tmpl.content, parsed.args, options.workspaceRoot);
                const userMsg = params.session[params.session.length - 1] as unknown as {
                  role: string;
                  content: { text: string }[];
                };
                if (userMsg.content[0]) userMsg.content[0].text = expanded;
                params.session[params.session.length - 1] = {
                  ...userMsg,
                } as unknown as (typeof params.session)[number];
              }
            }
          }
          if (params.images?.length) {
            const last = params.session[params.session.length - 1];
            if (last && last.role === "user") {
              last.content = [...last.content, ...params.images];
            } else {
              params.session = [...params.session, { role: "user", content: [...params.images] }];
            }
          }
          let turnScope: SessionScope | undefined;
          if (builtinsMode) {
            turnScope = await getOrCreateScope(sessionId, mentioned.length === 1 ? mentioned[0] : undefined);
            await turnScope.todos.hydrate(sessionId);
          }
          const approvals = approvalsFor(sessionId);
          const requestApproval: RequestApproval = async (request) => {
            try {
              eventBus.emit("permission.asked", {
                tool: request.tool,
                command: request.command,
                path: request.path,
                decision: "ask",
              });
              eventBus.emit("event", { event: "permission.asked", payload: { tool: request.tool } });
            } catch {}
            if (approvals.hasAlways(request)) {
              try {
                eventBus.emit("permission.replied", {
                  tool: request.tool,
                  command: request.command,
                  path: request.path,
                  decision: "once",
                });
                eventBus.emit("event", {
                  event: "permission.replied",
                  payload: { tool: request.tool, decision: "once" },
                });
              } catch {}
              return "once";
            }
            const { id, promise } = approvals.createPending(request, params.turnId);
            const payload = { type: "approval_requested" as const, requestId: id, request };
            broadcast(eventStream, payload);
            if (params.sessionId !== undefined) broadcast(`session.${sessionId}`, payload);
            const decision = await promise;
            try {
              eventBus.emit("permission.replied", {
                tool: request.tool,
                command: request.command,
                path: request.path,
                decision,
              });
              eventBus.emit("event", {
                event: "permission.replied",
                payload: { tool: request.tool, decision },
              });
            } catch {}
            return decision;
          };
          const fallbackRef = (() => {
            const fm = (config as unknown as { fallback_model?: string }).fallback_model;
            if (!fm) return undefined;
            const slash = fm.indexOf("/");
            if (slash <= 0) return undefined;
            return { provider: fm.slice(0, slash), model: fm.slice(slash + 1) };
          })();

          let result: Awaited<ReturnType<typeof runTurn>>;
          try {
            const effectiveCapabilities =
              params.capabilities ??
              (builtinsMode ? await defaultCapabilitiesForSession(sessionId) : defaultCapabilitiesSync);
            const effectiveMcpFailures = builtinsMode ? turnScope?.mcpFailures : undefined;
            const sessionGate = gateForSession(sessionId);
            const effectiveTools =
              builtinsMode && turnScope
                ? turnScope.tools.filter((t) => sessionGate.toolOffered(t.name, t.riskTier))
                : tools.filter((t) => sessionGate.toolOffered(t.name, t.riskTier));
            activeTurnMeta.set(params.turnId, {
              capabilities: effectiveCapabilities,
              tools: effectiveTools,
              sessionId,
              provider: params.provider,
              model: params.model,
              apiKey,
              budget: params.budget,
              taskDepth: (params as unknown as { taskDepth?: number }).taskDepth ?? 0,
            });
            try {
              const mailboxDrain = (() => {
                const agentForSession = orchestraRegistry.list().find((a) => a.sessionId === sessionId);
                const handle = agentForSession?.handle ?? (mentioned.length === 1 ? mentioned[0] : undefined);
                if (!handle) return undefined;
                return () => {
                  const msgs: import("@agency/schema").Message[] = [];
                  const box = agentMailboxes.get(handle);
                  if (box && box.length > 0) {
                    msgs.push(...box);
                    box.length = 0;
                  }
                  const reg = orchestraRegistry.get(handle)?.mailbox;
                  if (reg && reg.length > 0) {
                    msgs.push(...reg);
                    reg.length = 0;
                  }
                  return msgs;
                };
              })();
              try {
                const promptText = (() => {
                  const m = params.session[params.session.length - 1];
                  const b = m?.content?.find((c: { type: string }) => c.type === "text") as
                    | { text?: string }
                    | undefined;
                  return typeof b?.text === "string" ? b.text : "";
                })();
                eventBus.emit("prompt.submit", { sessionId, prompt: promptText });
                eventBus.emit("event", {
                  event: "prompt.submit",
                  payload: { sessionId, prompt: promptText },
                });
              } catch {}
              result = await runTurn(adapterFor(resolvedProvider), schedulerFor(resolvedProvider), http, {
                identity,
                capabilities: effectiveCapabilities,
                toolPolicy: sessionGate,
                requestApproval,
                eventBus,
                drainMailbox: mailboxDrain,
                systemPrompt: resolveSystemPrompt(params, {
                  workspaceRoot: options.workspaceRoot,
                  mcpFailures: effectiveMcpFailures,
                  shellLabel,
                }),
                tools: effectiveTools,
                model: resolvedModel,
                apiKey,
                provider: resolvedProvider,
                promptVersion: tracePromptVersion,
                traceRecorder,
                thinkingLevel:
                  (resolvedThinkingLevel as import("@agency/providers").ThinkingLevel | undefined) ??
                  params.thinkingLevel,
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
                taskDepth: (params as unknown as { taskDepth?: number }).taskDepth ?? 0,
                onEvent: wrappedOnEvent,
              });
            } finally {
              activeTurnMeta.delete(params.turnId);
            }
          } catch (error) {
            const isRetryable =
              error instanceof AgencyError &&
              (error.code === ErrorCode.OVERLOAD ||
                error.code === ErrorCode.TRANSIENT ||
                error.code === ErrorCode.RATE_LIMIT);
            if (isRetryable && fallbackRef && fallbackRef.provider !== params.provider) {
              const fbEvent = {
                type: "fallback" as const,
                from: `${params.provider}/${params.model}`,
                to: `${fallbackRef.provider}/${fallbackRef.model}`,
                reason: error instanceof Error ? error.message : String(error),
              };
              broadcast(eventStream, fbEvent);
              try {
                eventBus.emit("model.fallback", fbEvent);
              } catch {}
              const fbApiKey = await (async () => {
                let kc: KeychainBackend | undefined;
                try {
                  kc = await getKeychain();
                } catch {}
                const k = await resolveApiKey({
                  provider: fallbackRef.provider,
                  env: process.env,
                  keychain: kc,
                  config: providers[fallbackRef.provider]?.apiKey,
                  ...oauthOverridesFor(fallbackRef.provider, providers),
                });
                return k ?? apiKey;
              })();
              if (fbApiKey) redactor.registerSecret(fbApiKey);
              const sessionGate = gateForSession(sessionId);
              const fallbackCapabilities =
                params.capabilities ??
                (builtinsMode ? await defaultCapabilitiesForSession(sessionId) : defaultCapabilitiesSync);
              const fallbackMcpFailures = builtinsMode ? turnScope?.mcpFailures : undefined;
              const fallbackTools =
                builtinsMode && turnScope
                  ? turnScope.tools.filter((t) => sessionGate.toolOffered(t.name, t.riskTier))
                  : tools.filter((t) => sessionGate.toolOffered(t.name, t.riskTier));
              activeTurnMeta.set(params.turnId, {
                capabilities: fallbackCapabilities,
                tools: fallbackTools,
                sessionId,
                provider: fallbackRef.provider,
                model: fallbackRef.model,
                apiKey: fbApiKey ?? apiKey,
                budget: params.budget,
                taskDepth: (params as unknown as { taskDepth?: number }).taskDepth ?? 0,
              });
              try {
                result = await runTurn(
                  adapterFor(fallbackRef.provider),
                  schedulerFor(fallbackRef.provider),
                  http,
                  {
                    identity,
                    capabilities: fallbackCapabilities,
                    toolPolicy: sessionGate,
                    requestApproval,
                    eventBus,
                    systemPrompt: resolveSystemPrompt(params, {
                      workspaceRoot: options.workspaceRoot,
                      mcpFailures: fallbackMcpFailures,
                      shellLabel,
                    }),
                    tools: fallbackTools,
                    model: fallbackRef.model,
                    apiKey: fbApiKey ?? apiKey,
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
                    taskDepth: (params as unknown as { taskDepth?: number }).taskDepth ?? 0,
                    provider: fallbackRef.provider,
                    promptVersion: tracePromptVersion,
                    traceRecorder,
                    onEvent: wrappedOnEvent,
                  },
                );
              } finally {
                activeTurnMeta.delete(params.turnId);
              }
            } else {
              throw error;
            }
          }
          try {
            if (traceRecorder) {
              const cassetteMcpFailures = builtinsMode ? turnScope?.mcpFailures : undefined;
              const sysPrompt = resolveSystemPrompt(params, {
                workspaceRoot: options.workspaceRoot,
                mcpFailures: cassetteMcpFailures,
                shellLabel,
              });
              const record = traceRecorder.toCassetteRecord(
                {
                  provider: params.provider,
                  model: params.model,
                  systemPrompt: sysPrompt,
                  session: params.session,
                },
                collectedTraceEvents,
                result,
              );
              void traceRecorder.writeCassette(params.turnId, record);
            }
          } catch {}
          try {
            eventBus.emit("session.idle", { sessionId });
            eventBus.emit("event", { event: "session.idle", payload: { sessionId } });
          } catch {}

          const costUsd = modelInfo
            ? (result.usage.inputTokens / 1_000_000) * modelInfo.pricing.inputPerMTok +
              (result.usage.outputTokens / 1_000_000) * modelInfo.pricing.outputPerMTok
            : 0;
          const sidKey = sessionId;
          orchestraCost.set(sidKey, (orchestraCost.get(sidKey) ?? 0) + costUsd);
          orchestraTotalCost += costUsd;
          if (budgets?.orchestraUsd !== undefined && orchestraTotalCost >= budgets.orchestraUsd) {
            for (const c of activeControllers.values())
              try {
                c.abort();
              } catch {}
          }
          logger.info("turn finished", {
            turnId: params.turnId,
            stopReason: result.stopReason,
            inputTokens: result.usage.inputTokens,
            outputTokens: result.usage.outputTokens,
            cachedInputTokens: result.usage.cachedInputTokens ?? null,
          });
          telemetry.record("turn_complete", {
            provider: resolvedProvider,
            stopReason: result.stopReason,
            inputTokens: result.usage.inputTokens,
            outputTokens: result.usage.outputTokens,
            cachedInputTokens: result.usage.cachedInputTokens ?? null,
          });

          // Generate session title after first turn if none exists yet
          if (!getSessionTitle(todoStore.load(sessionId))) {
            const firstUserMsg = params.session.find((m: Message) => m.role === "user");
            const firstUserText = firstUserMsg?.content?.find((b: { type: string }) => b.type === "text") as
              | { text?: string }
              | undefined;
            if (firstUserText?.text) {
              const titlePrompt = firstUserText.text;
              const smallModelRef = resolveSmallModel(config);
              if (smallModelRef) {
                (async () => {
                  try {
                    let kc: KeychainBackend | undefined;
                    try {
                      kc = await getKeychain();
                    } catch {}
                    const smallApiKey = await resolveApiKey({
                      provider: smallModelRef.provider,
                      env: process.env,
                      keychain: kc,
                      config: providers[smallModelRef.provider]?.apiKey,
                      ...oauthOverridesFor(smallModelRef.provider, providers),
                    });
                    if (smallApiKey) {
                      const title = await generateTitle(titlePrompt, {
                        config,
                        http,
                        apiKey: smallApiKey,
                        providerConfig: providers,
                        adapterFor: (p: string) => adapterFor(p),
                      });
                      if (title) {
                        const tip = todoStore.latestTip(todoStore.load(sessionId)) ?? null;
                        await todoStore.append(sessionId, { type: "session_title", parentId: tip, title });
                      }
                    }
                  } catch {
                    // Title generation failure must not fail the turn
                  }
                })();
              }
            }
          }

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
      // A turn parked at the ask gate awaits an approval promise the abort
      // signal alone never settles, so without this run_turn would hang past
      // cancellation. Refusing the pending asks lets the loop observe the
      // abort and finish instead of deadlocking.
      for (const manager of approvalManagers.values()) manager.rejectTurn(turnId);
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

    async agent_message(rawParams) {
      const { from, to, body, sessionId } = rawParams as {
        from: string;
        to: string;
        body: string;
        sessionId?: string;
      };
      const sid = sessionId ?? "default";
      const entrySid = sid;
      try {
        const tip = todoStore.latestTip(todoStore.load(entrySid)) ?? null;
        await todoStore.append(entrySid, { type: "agent_message", parentId: tip, from, to, body });
      } catch {}
      const box = agentMailboxes.get(to);
      if (box) box.push({ role: "user", content: [{ type: "text", text: `[from ${from}] ${body}` }] });
      else {
        const mbox = orchestraRegistry.get(to)?.mailbox;
        if (mbox) mbox.push({ role: "user", content: [{ type: "text", text: `[from ${from}] ${body}` }] });
      }
      try {
        eventBus.emit("agent.message", { from, to, body });
      } catch {}
      return { delivered: true };
    },

    async agents_list() {
      return agentsListPayload();
    },

    async agent_history(rawParams) {
      const { handle } = rawParams as { handle: string };
      if (typeof handle !== "string" || handle.length === 0) {
        throw new AgencyError(ErrorCode.INTERNAL, "agent_history requires handle", { source: "orchestra" });
      }
      const agent = orchestraRegistry.get(handle);
      if (!agent) {
        throw new AgencyError(ErrorCode.INTERNAL, `unknown handle: ${handle}`, { source: "orchestra" });
      }
      const sid = agent.sessionId;
      const entries = todoStore.load(sid);
      const tip = todoStore.latestTip(entries) ?? null;
      const messages = tip ? todoStore.messagesFor(entries, tip) : [];
      return { handle, sessionId: sid, entries, messages };
    },

    orchestra_status: orchestraStatusHandler,

    // Back-compat alias: swarm_status -> orchestra_status
    swarm_status: orchestraStatusHandler,

    async dispatch_compare(rawParams) {
      const { handles, prompt, effort } = rawParams as { handles: string[]; prompt: string; effort?: string };
      if (!Array.isArray(handles) || handles.length === 0) {
        throw new AgencyError(ErrorCode.INTERNAL, "dispatch_compare requires handles", {
          source: "orchestra",
        });
      }
      if (typeof prompt !== "string" || prompt.trim().length === 0) {
        throw new AgencyError(ErrorCode.INTERNAL, "dispatch_compare requires prompt", {
          source: "orchestra",
        });
      }
      const leanPromptText = leanPrompt(prompt);
      try {
        broadcast(`orchestra.shared`, { type: "dispatch_compare_start", count: handles.length, handles });
      } catch {}
      // Back-compat dual-publish to swarm.* channels
      try {
        broadcast(`swarm.shared`, { type: "dispatch_compare_start", count: handles.length, handles });
      } catch {}
      const compareScheduler = new Scheduler({ maxConcurrent: Math.max(8, handles.length) });
      const { results } = await spawnParallel(
        handles,
        async (handle): Promise<{ handle: string; result: string }> => {
          const agent = orchestraRegistry.get(handle);
          if (!agent) {
            return { handle, result: `unknown handle: ${handle}` };
          }
          const compareBudgets = (
            config as unknown as { budgets?: { perAgentUsd?: number; orchestraUsd?: number } }
          ).budgets;
          if (
            compareBudgets?.orchestraUsd !== undefined &&
            orchestraTotalCost >= compareBudgets.orchestraUsd
          ) {
            return {
              handle,
              result: `${handle}: orchestra budget exceeded: ${orchestraTotalCost} >= ${compareBudgets.orchestraUsd}`,
            };
          }
          const spentForHandle = orchestraCost.get(agent.sessionId) ?? 0;
          if (compareBudgets?.perAgentUsd !== undefined && spentForHandle >= compareBudgets.perAgentUsd) {
            return {
              handle,
              result: `${handle}: budget exceeded: per-agent ${spentForHandle} >= ${compareBudgets.perAgentUsd}`,
            };
          }
          const childSessionId = agent.sessionId;
          try {
            todoStore.create(childSessionId);
          } catch {}
          await getOrCreateScope(childSessionId, handle);
          const resolvedEffort =
            effort ?? (agent.effort === "auto" ? classifyEffortFromText(prompt) : agent.effort);
          // --- Real turn execution (concurrent per handle) ---
          const childProvider = agent.provider;
          const childModel = agent.model ?? "";
          const childModelInfo = catalogModel(childProvider, childModel);
          const clampedEffort = clampEffortForModel(
            resolvedEffort as import("@agency/providers").EffortLevel,
            childModelInfo,
          );
          agentStates.set(handle, "working");
          if (orchestraRegistry.list().length > 1) {
            try {
              broadcast(`orchestra.${childSessionId}`, {
                type: "agent_lifecycle",
                handle,
                state: "working",
                detail: prompt.slice(0, 200),
                effort: clampedEffort,
              });
            } catch {}
            try {
              broadcast(`orchestra.shared`, {
                type: "agent_lifecycle",
                handle,
                state: "working",
                detail: prompt.slice(0, 200),
                effort: clampedEffort,
              });
            } catch {}
            // Back-compat dual-publish to swarm.* channels
            try {
              broadcast(`swarm.${childSessionId}`, {
                type: "agent_lifecycle",
                handle,
                state: "working",
                detail: prompt.slice(0, 200),
                effort: clampedEffort,
              });
            } catch {}
            try {
              broadcast(`swarm.shared`, {
                type: "agent_lifecycle",
                handle,
                state: "working",
                detail: prompt.slice(0, 200),
                effort: clampedEffort,
              });
            } catch {}
          }

          let childApiKey = "";
          try {
            const kc = await getKeychain();
            const k = await resolveApiKey({
              provider: childProvider,
              env: process.env,
              keychain: kc,
              config: providers[childProvider]?.apiKey,
              ...oauthOverridesFor(childProvider, providers),
            });
            if (k) {
              childApiKey = k;
              redactor.registerSecret(k);
            }
          } catch {}

          const childTurnId = newEntryId();
          const startMs = Date.now();

          const childTraceRecorder = (() => {
            try {
              return new TraceRecorder({
                sessionsDir: todoSessionsDir,
                sessionId: childSessionId,
                traceId: childTurnId,
                provider: childProvider,
                model: childModel,
                redactor,
              });
            } catch {
              return undefined;
            }
          })();

          const childEvents: LoopEvent[] = [];
          const adapter = adapterFor(childProvider);
          const scheduler = compareScheduler;

          const freshSession: Message[] = [
            { role: "user", content: [{ type: "text", text: leanBrief(prompt) }] },
          ];

          const childScope = sessionScopes.get(childSessionId);
          const childTools = childScope?.tools ?? [];
          const agentGate = gateForAgent(handle);
          const offeredTools = childTools
            .filter((t) => agentGate.toolOffered(t.name, t.riskTier))
            // Depth-0 child isolation: subagents cannot dispatch or spawn tasks.
            .filter((t) => t.name !== "dispatch" && t.name !== "task");
          const agentCaps = capabilitiesForAgent(agentGate, childTools);

          const agentSystemPrompt = composeSystemPrompt({
            base: `You are ${handle}, a ${agent.role} agent. Compare and respond to the given prompt concisely.`,
            familyPresetOverlay: undefined,
            instructions: [],
            toolDescriptions: [],
            context: buildEnvironmentBlock(gatherEnvironmentInfo({ cwd: options.workspaceRoot })),
          });

          let childResult: Awaited<ReturnType<typeof runTurn>> | undefined;
          let childError: unknown;
          try {
            childResult = await runTurn(adapter, scheduler, http, {
              identity: { type: "agent", name: handle },
              capabilities: agentCaps,
              toolPolicy: agentGate,
              eventBus,
              systemPrompt: agentSystemPrompt.text,
              tools: offeredTools as unknown as import("@agency/core").ToolSpec[],
              model: childModel,
              apiKey: childApiKey,
              provider: childProvider,
              traceRecorder: childTraceRecorder,
              session: freshSession,
              pricePerMTok: childModelInfo
                ? { input: childModelInfo.pricing.inputPerMTok, output: childModelInfo.pricing.outputPerMTok }
                : undefined,
              maxTokensPerRequest: childModelInfo?.maxOutputTokens,
              turnId: childTurnId,
              sessionId: childSessionId,
              cwd: options.workspaceRoot,
              taskDepth: 1,
              doomLoopDetection: true,
              drainMailbox: () => {
                const drained: import("@agency/schema").Message[] = [];
                const box = agentMailboxes.get(handle);
                if (box && box.length > 0) {
                  drained.push(...box);
                  box.length = 0;
                }
                const reg = orchestraRegistry.get(handle)?.mailbox;
                if (reg && reg.length > 0) {
                  drained.push(...reg);
                  reg.length = 0;
                }
                return drained;
              },
              onEvent: (ev) => {
                childEvents.push(ev);
              },
            });
          } catch (e) {
            childError = e;
          }

          if (childResult && childModelInfo) {
            const costUsd =
              (childResult.usage.inputTokens / 1_000_000) * childModelInfo.pricing.inputPerMTok +
              (childResult.usage.outputTokens / 1_000_000) * childModelInfo.pricing.outputPerMTok;
            orchestraCost.set(childSessionId, (orchestraCost.get(childSessionId) ?? 0) + costUsd);
            orchestraTotalCost += costUsd;
          }

          const durationMs = Date.now() - startMs;
          const finalText = childResult ? extractFinalText(childResult.messages) : "";
          const collapsed = leanSummary(
            finalText || (childError instanceof Error ? childError.message : String(childError ?? "")),
          );
          try {
            const parentLatestTip = todoStore.latestTip(todoStore.load(childSessionId)) ?? null;
            await todoStore.append(childSessionId, {
              type: "task_result",
              parentId: parentLatestTip,
              tool: "dispatch_compare",
              childSessionId,
              childTurnId,
              durationMs,
              summary: collapsed || leanSummary(finalText),
              prompt: leanPromptText,
            });
          } catch {}

          if (childError) {
            agentStates.set(handle, "failed");
            try {
              const tip2 = todoStore.latestTip(todoStore.load(childSessionId)) ?? null;
              await todoStore
                .append(childSessionId, {
                  type: "agent_lifecycle",
                  parentId: tip2,
                  handle,
                  state: "failed",
                  detail: childError instanceof Error ? childError.message : String(childError),
                })
                .catch(() => {
                  /* best-effort lifecycle persistence */
                });
            } catch {}
            if (orchestraRegistry.list().length > 1) {
              try {
                broadcast(`orchestra.${childSessionId}`, {
                  type: "agent_lifecycle",
                  handle,
                  state: "failed",
                });
              } catch {}
              try {
                broadcast(`orchestra.shared`, { type: "agent_lifecycle", handle, state: "failed" });
              } catch {}
              // Back-compat dual-publish to swarm.* channels
              try {
                broadcast(`swarm.${childSessionId}`, { type: "agent_lifecycle", handle, state: "failed" });
              } catch {}
              try {
                broadcast(`swarm.shared`, { type: "agent_lifecycle", handle, state: "failed" });
              } catch {}
            }
            return {
              handle,
              result: `${handle}: ${childError instanceof Error ? childError.message : String(childError)}`,
            };
          } else {
            agentStates.set(handle, "idle");
            try {
              const tip2 = todoStore.latestTip(todoStore.load(childSessionId)) ?? null;
              await todoStore
                .append(childSessionId, {
                  type: "agent_lifecycle",
                  parentId: tip2,
                  handle,
                  state: "idle",
                  detail: "compare done",
                })
                .catch(() => {
                  /* best-effort lifecycle persistence */
                });
            } catch {}
            if (orchestraRegistry.list().length > 1) {
              try {
                broadcast(`orchestra.${childSessionId}`, { type: "agent_lifecycle", handle, state: "idle" });
              } catch {}
              try {
                broadcast(`orchestra.shared`, { type: "agent_lifecycle", handle, state: "idle" });
              } catch {}
              // Back-compat dual-publish to swarm.* channels
              try {
                broadcast(`swarm.${childSessionId}`, { type: "agent_lifecycle", handle, state: "idle" });
              } catch {}
              try {
                broadcast(`swarm.shared`, { type: "agent_lifecycle", handle, state: "idle" });
              } catch {}
            }
            return {
              handle,
              result: `${handle} (${agent.provider}/${agent.model}) · ${leanSummary(finalText, 120) || "(no output)"}`,
            };
          }
        },
        {
          onSettle: (settled) => {
            try {
              eventBus.emit("dispatch.compare.complete", { count: settled.length });
            } catch {}
            try {
              broadcast(`orchestra.shared`, { type: "dispatch_compare_complete", count: settled.length });
            } catch {}
            // Back-compat dual-publish to swarm.* channels
            try {
              broadcast(`swarm.shared`, { type: "dispatch_compare_complete", count: settled.length });
            } catch {}
          },
        },
      );
      try {
        eventBus.emit("dispatch.compare", { handles, prompt: leanPromptText });
      } catch {}
      return { results };
    },

    orchestra_stop: orchestraStopHandler,

    // Back-compat alias: swarm_stop -> orchestra_stop
    swarm_stop: orchestraStopHandler,

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
        throw new AgencyError(ErrorCode.TOOL_ERROR, error instanceof Error ? error.message : String(error), {
          source: "plan",
          context: { path },
        });
      }
    },

    async undo(rawParams?: unknown) {
      const p = rawParams as { sessionId?: string } | undefined;
      const snapshots = options.tools
        ? undefined
        : ((p?.sessionId ? sessionScopes.get(p.sessionId)?.snapshots : undefined) ??
          sessionScopes.get("default")?.snapshots ??
          [...sessionScopes.values()][0]?.snapshots);
      const outcome = snapshots?.undo();
      return { undone: outcome !== undefined, ...(outcome ? { path: outcome.path } : {}) };
    },

    async redo(rawParams?: unknown) {
      const p = rawParams as { sessionId?: string } | undefined;
      const snapshots = options.tools
        ? undefined
        : ((p?.sessionId ? sessionScopes.get(p.sessionId)?.snapshots : undefined) ??
          sessionScopes.get("default")?.snapshots ??
          [...sessionScopes.values()][0]?.snapshots);
      const outcome = snapshots?.redo();
      return { undone: outcome !== undefined, ...(outcome ? { path: outcome.path } : {}) };
    },

    async providers_list() {
      const base = await listProviders({ config, http, catalog: options.catalog });
      let mcpFailures: Record<string, string> = {};
      let lspStatuses: Record<string, string> = {};
      if (builtinsMode) {
        const first = sessionScopes.get("default") ?? [...sessionScopes.values()][0];
        if (first?.mcpFailures) mcpFailures = Object.fromEntries(first.mcpFailures);
        if (first?.lspRegistry) lspStatuses = first.lspRegistry.statuses();
      }
      return { ...base, mcpFailures, lspStatuses };
    },

    async mcp_status(rawParams?: unknown) {
      const p = rawParams as { sessionId?: string } | undefined;
      if (builtinsMode && p?.sessionId) {
        const s = sessionScopes.get(p.sessionId);
        return { failures: s ? Object.fromEntries(s.mcpFailures) : {} };
      }
      return { failures: {} as Record<string, string> };
    },

    async lsp_status(rawParams?: unknown) {
      const p = rawParams as { sessionId?: string } | undefined;
      if (builtinsMode && p?.sessionId) {
        const s = sessionScopes.get(p.sessionId);
        return { statuses: s?.lspRegistry?.statuses() ?? {} };
      }
      return { statuses: {} as Record<string, string> };
    },

    async session_delete(rawParams) {
      const { sessionId } = rawParams as { sessionId: string };
      if (!sessionId)
        throw new AgencyError(ErrorCode.INTERNAL, "session_delete requires sessionId", {
          source: "session",
        });
      const scope = sessionScopes.get(sessionId);
      if (scope) {
        try {
          await scope.dispose();
        } catch {}
        sessionScopes.delete(sessionId);
      }
      approvalManagers.delete(sessionId);
      try {
        todoStore.delete(sessionId);
      } catch {}
      return { deleted: true };
    },

    async session_fork(rawParams) {
      const { sessionId, fromTipId, label } = rawParams as {
        sessionId: string;
        fromTipId?: string;
        label?: string;
      };
      if (!sessionId)
        throw new AgencyError(ErrorCode.INTERNAL, "session_fork requires sessionId", {
          source: "session",
        });
      if (todoStore.load(sessionId).length === 0)
        throw new AgencyError(ErrorCode.INTERNAL, `unknown session: ${sessionId}`, {
          source: "session",
        });
      const entry = await todoStore.fork(sessionId, {
        ...(fromTipId === undefined ? {} : { fromTipId }),
        ...(label === undefined ? {} : { label }),
      });
      return { forked: true, sessionId, tipId: entry.id };
    },

    async session_clone(rawParams) {
      const { sessionId, newSessionId } = rawParams as {
        sessionId: string;
        newSessionId?: string;
      };
      if (!sessionId)
        throw new AgencyError(ErrorCode.INTERNAL, "session_clone requires sessionId", {
          source: "session",
        });
      if (todoStore.load(sessionId).length === 0)
        throw new AgencyError(ErrorCode.INTERNAL, `unknown session: ${sessionId}`, {
          source: "session",
        });
      const meta = todoStore.clone(
        sessionId,
        typeof newSessionId === "string" && newSessionId.length > 0 ? newSessionId : undefined,
      );
      return { cloned: true, sessionId: meta.id };
    },

    async session_show(rawParams) {
      const { sessionId, tipId } = rawParams as { sessionId: string; tipId?: string };
      if (!sessionId)
        throw new AgencyError(ErrorCode.INTERNAL, "session_show requires sessionId", {
          source: "session",
        });
      const entries = todoStore.load(sessionId);
      if (entries.length === 0)
        throw new AgencyError(ErrorCode.INTERNAL, `unknown session: ${sessionId}`, {
          source: "session",
        });
      const last = entries[entries.length - 1];
      const tip = tipId ?? todoStore.latestTip(entries) ?? last?.id ?? "";
      return { sessionId, entries, tipId: tip, messages: todoStore.messagesFor(entries, tip) };
    },

    async commands_list() {
      return {
        commands: commands.map((c) => ({
          name: c.name,
          description: c.description,
          source: c.source,
          path: c.path,
        })),
      };
    },

    async commands_expand(rawParams) {
      const { name, args } = rawParams as { name: string; args?: string };
      const tmpl = commands.find((c) => c.name === name);
      if (!tmpl)
        throw new AgencyError(ErrorCode.INTERNAL, `unknown command: ${name}`, { source: "commands" });
      const expanded = expandCommand(tmpl.content, args ?? "", options.workspaceRoot);
      return { expanded, name };
    },

    async trace_get(rawParams) {
      const { sessionId, turnId } = rawParams as { sessionId: string; turnId?: string };
      if (!sessionId)
        throw new AgencyError(ErrorCode.INTERNAL, "trace_get requires sessionId", { source: "trace" });
      const spans = loadTraceSpansSync(todoSessionsDir, sessionId);
      const filtered = turnId ? spans.filter((s) => s.traceId === turnId) : spans;
      const tree = buildSpanTree(filtered);
      return { spans: filtered, tree };
    },

    async trace_replay(rawParams) {
      const { sessionId, turnId, overrides } = rawParams as {
        sessionId: string;
        turnId: string;
        overrides?: {
          model?: string;
          provider?: string;
          thinkingLevel?: ThinkingLevel;
          systemPrompt?: string;
          effort?: string;
        };
      };
      if (!sessionId || !turnId)
        throw new AgencyError(ErrorCode.INTERNAL, "trace_replay requires sessionId and turnId", {
          source: "trace",
        });
      const record = await readCassetteRecord(todoSessionsDir, sessionId, turnId);
      if (!record)
        throw new AgencyError(ErrorCode.INTERNAL, `no cassette for ${sessionId}/${turnId}`, {
          source: "trace",
        });
      const targetProvider = overrides?.provider ?? record.params.provider;
      const targetModel = overrides?.model ?? record.params.model;
      const targetSystemPrompt = overrides?.systemPrompt ?? record.params.systemPrompt;
      const thinkingLevel = overrides?.thinkingLevel;
      const targetAdapter = adapterFor(targetProvider);
      const targetScheduler = schedulerFor(targetProvider);
      const replayCaps = builtinsMode
        ? await defaultCapabilitiesForSession(sessionId)
        : defaultCapabilitiesSync;
      const replayTools = builtinsMode
        ? ((sessionScopes.get(sessionId) ?? [...sessionScopes.values()][0])?.tools.filter((t) =>
            gate.toolOffered(t.name, t.riskTier),
          ) ?? tools.filter((t) => gate.toolOffered(t.name, t.riskTier)))
        : tools.filter((t) => gate.toolOffered(t.name, t.riskTier));
      const replayed = await runTurn(targetAdapter, targetScheduler, http, {
        identity,
        capabilities: replayCaps,
        toolPolicy: gate,
        eventBus,
        systemPrompt: targetSystemPrompt,
        tools: replayTools,
        model: targetModel,
        apiKey: await (async () => {
          const k = await (async () => {
            let kc: KeychainBackend | undefined;
            try {
              kc = await getKeychain();
            } catch {}
            return resolveApiKey({
              provider: targetProvider,
              env: process.env,
              keychain: kc,
              config: providers[targetProvider]?.apiKey,
              ...oauthOverridesFor(targetProvider, providers),
            });
          })();
          return k ?? "replay-key";
        })(),
        thinkingLevel: thinkingLevel as ThinkingLevel | undefined,
        session: record.params.session,
        cwd: options.workspaceRoot,
        maxToolIterations: 25,
      });
      const equal = JSON.stringify(replayed.messages) === JSON.stringify(record.result.messages);
      return { equal, original: record, replayed };
    },

    async trace_export(rawParams) {
      const { sessionId, turnId } = rawParams as { sessionId: string; turnId?: string };
      const exportCfg = (
        config as unknown as { trace?: { export?: { endpoint: string; headers?: Record<string, string> } } }
      ).trace?.export;
      if (!exportCfg?.endpoint) return { exported: false, reason: "not configured" };
      const spans = loadTraceSpansSync(todoSessionsDir, sessionId ?? "");
      const filtered = turnId ? spans.filter((s) => s.traceId === turnId) : spans;
      if (filtered.length === 0) return { exported: false, reason: "no spans" };
      const payload = spansToOtlp(filtered);
      try {
        await fetch(exportCfg.endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json", ...(exportCfg.headers ?? {}) },
          body: JSON.stringify(payload),
        });
      } catch (error) {
        throw new AgencyError(
          ErrorCode.INTERNAL,
          `trace export failed: ${error instanceof Error ? error.message : String(error)}`,
          { source: "trace" },
        );
      }
      return { exported: true, endpoint: exportCfg.endpoint };
    },
  };

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
  httpGateway = startHttpGateway({
    handlers,
    token: authToken,
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
