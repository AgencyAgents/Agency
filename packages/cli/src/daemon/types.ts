import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  type AgentRegistry,
  type AutoReviewer,
  type BoardStore,
  type Budget,
  buildEnvironmentBlock,
  type ChannelStore,
  type ChoiceLog,
  type CommandTemplate,
  type Config,
  type ToolSpec as CoreToolSpec,
  composeSystemPrompt,
  createAutoReviewer,
  type DispatchStateStore,
  type EventBus,
  environmentDate,
  type GitRunner,
  gatherEnvironmentInfo,
  type HookRunOptions,
  type InboxStore,
  type Logger,
  loadInstructions,
  mcpServerDownReminder,
  type PluginAgentContribution,
  type PluginCommandContribution,
  type ProviderConfig,
  parseModelRef,
  resolveSmallModel,
  runTurn,
  type SessionStore,
  type SystemReminder,
  type TraceRecorder,
  type TurnError,
  type WakeRegistry,
  withPromptVersion,
  withSystemReminders,
} from "@agency/core";
import {
  type ApprovalManager,
  type CallerIdentity,
  type Capabilities,
  FULL_CAPABILITIES,
  globToRegExpSource,
  type PermissionMode,
  type PermissionsGate,
  type Redactor,
  type SandboxBackend,
} from "@agency/guard";
import type { HttpClient } from "@agency/net";
import {
  anthropicAdapter,
  type CacheSegment,
  chatgptAdapter,
  classifyEffortFromText,
  createOpenAiCompatibleAdapter,
  GATEWAY_BASE_URLS,
  googleAdapter,
  type KeychainBackend,
  type ModelInfo,
  openaiAdapter,
  type ProviderAdapter,
  resolveApiKey,
  type Scheduler,
  type ThinkingLevel,
  type Usage,
} from "@agency/providers";
import type { DaemonServer } from "@agency/rpc";
import { AgencyError, ErrorCode, type Message, type StopReason } from "@agency/schema";
import type { Telemetry } from "@agency/telemetry";
import {
  MAX_MEMORY_NOTES,
  readMemoryNotes,
  type SessionScope,
  type ToolSpec as ToolsToolSpec,
} from "@agency/tools";
import type { TeamContext } from "./team-context.ts";

export type { SystemReminder };

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
  "testing, linting, and running the project, never as a substitute for the read/write/edit " +
  "tools; report command output verbatim when it matters and summarize otherwise.\n" +
  "Shell dialect: commands run in the session shell named in the environment block: " +
  "write every command in that shell's syntax (PowerShell, cmd.exe, and POSIX sh differ " +
  "in quoting, chaining, and env-var expansion); default to POSIX sh only when no shell " +
  "is named.";

export const STRUCTURED_OUTPUT_TOOL = "structured_output";

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
   * Optional (A3): the daemon resolves the key itself, env -> keychain ->
   * config, the same layered precedence as every other surface, so keys no
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
  /** A JSON Schema for the final answer: the turn gets a `structured_output` tool with it as the input schema. */
  outputSchema?: Record<string, unknown>;
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
  /**
   * Non-interactive permission mode for this turn (`ask` default).
   * Every other mode arrives only via the explicit client flag.
   */
  permissionMode?: PermissionMode;
  /** Headless turns have no approval surface: asks refuse at once with a
   *  typed reason instead of waiting on a responder that never comes. */
  nonInteractive?: boolean;
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
  /** Gate for AGENTS.md, CLAUDE.md and .agency/rules: the daemon loads them unless the client sent its own. */
  trustStore?: import("@agency/guard").TrustStore;
  /** Texts of the loaded plugins and skills. They go after the project instructions. */
  pluginInstructions?: readonly string[];
  /** The notes of the `memory` tool go last in the instructions. */
  memoryFile?: string;
  /** Environment block per session id. A block that changes between turns ends the prompt cache of the full history. */
  environments?: EnvironmentStore;
}

/**
 * The notes of the `memory` tool, as one instruction. ponytail: read on each turn, so a new note ends the prompt cache
 * once; keep the notes of the session start when that costs.
 */
export function memoryInstructions(file: string | undefined): string[] {
  const notes = file === undefined ? [] : readMemoryNotes(file).slice(0, MAX_MEMORY_NOTES);
  if (notes.length === 0) return [];
  return [
    `Your notes from earlier sessions in this workspace, which the memory tool keeps. A note can be out of date: check a fact before you rely on it.\n${notes.join("\n")}`,
  ];
}

/** Repo-provided text is an injection surface, so an untrusted workspace contributes none. */
export function projectInstructions(
  options: Pick<ResolveSystemPromptOptions, "workspaceRoot" | "trustStore">,
): string[] {
  if (options.trustStore === undefined) return [];
  try {
    return loadInstructions(options.trustStore, options.workspaceRoot, options.workspaceRoot);
  } catch (error) {
    if (error instanceof AgencyError && error.code === ErrorCode.PERMISSION_DENIED) return [];
    throw error;
  }
}

export interface RunTurnRpcResult {
  messages: Message[];
  stopReason: StopReason;
  usage: Usage;
  budgetExceeded: boolean;
  cancelled: boolean;
  /** Why the turn did not finish: the provider stream died after content arrived, or the step limit was reached. */
  error?: TurnError;
  /** Set when the fallback model produced the result: usage is priced as this model, not as the one requested. */
  servedBy?: { provider: string; model: string };
  /** Set when the turn failed with CONTEXT_OVERFLOW: the daemon produced no
   *  assistant messages, so the caller (which owns the SessionStore) can
   *  compact the session and retry the turn. */
  needsCompaction?: boolean;
}

/** Daemon-owned turn: the caller sends text, the daemon owns store,
 *  history, tokenizer, compaction, appends, and usage. */
export interface SessionSendParams {
  sessionId: string;
  /** Caller-supplied for pre-subscribe streaming; generated when absent. */
  turnId?: string;
  provider: string;
  model: string;
  systemPrompt: string;
  systemPromptParts?: SystemPromptParts;
  userText: string;
  images?: import("@agency/schema").ImageBlock[];
  thinkingLevel?: ThinkingLevel;
  budget?: Budget;
  permissionMode?: PermissionMode;
  maxToolIterations?: number;
  /** Headless turns refuse asks at once instead of waiting on a responder. */
  nonInteractive?: boolean;
  contextWindow?: number;
  /** Sets the goal of the session before this turn. An empty string clears it. */
  goal?: string;
}

export interface SessionSendResult extends RunTurnRpcResult {
  sessionId: string;
  turnId: string;
  tipId: string;
  compacted: boolean;
}

/** Mid-turn steering for the root turn: queued, then drained per tool
 *  iteration like the peer mailbox. */
export interface SessionMessageParams {
  sessionId: string;
  text: string;
}

/** The reviewer of auto mode for one turn, with its own block counts. Undefined in another mode. */
export function autoReviewerFor(
  ctx: Pick<DaemonContext, "config" | "hookRun">,
  mode: PermissionMode | undefined,
): AutoReviewer | undefined {
  const askModel = ctx.hookRun.askModel;
  if (mode !== "auto" || askModel === undefined) return undefined;
  return createAutoReviewer(askModel, ctx.config.auto_review_model);
}

/**
 * Adapter resolution over the merged provider set: a config-defined provider
 * speaks its declared family's wire format (defaulting to openai-compatible,
 * which makes any OpenAI-shaped gateway work with zero adapter code), a
 * builtin family id falls back to its native adapter, and a catalog provider or
 * built-in gateway id with a known API base URL gets the openai-compatible adapter pointed there.
 * Unknown ids still throw, but only after every layer had its chance.
 */
export function resolveAdapter(
  providerId: string,
  providers: Record<string, ProviderConfig>,
  catalogBaseUrls: Record<string, string> = {},
): ProviderAdapter {
  const config = providers[providerId] ?? {};
  // A builtin id keeps its native family when its config entry only adds a key, headers or model overrides.
  const native = NATIVE_ADAPTERS[config.family ?? providerId];
  if (native && config.family !== "openai-compatible") return bindEndpoint(native, config);

  const baseUrl = config.baseUrl ?? catalogBaseUrls[providerId] ?? GATEWAY_BASE_URLS[providerId];
  if (baseUrl) {
    return bindEndpoint(createOpenAiCompatibleAdapter(providerId, baseUrl), {
      headers: config.headers,
      streamIdleMs: config.streamIdleMs,
    });
  }
  if (providers[providerId] === undefined) {
    throw new Error(
      `unknown provider: ${providerId}. A provider with no built-in endpoint needs provider.${providerId}.baseUrl in the config.`,
    );
  }
  throw new Error(`provider "${providerId}" needs a baseUrl (no native endpoint for its family)`);
}

const NATIVE_ADAPTERS: Record<string, ProviderAdapter | undefined> = {
  anthropic: anthropicAdapter,
  openai: openaiAdapter,
  chatgpt: chatgptAdapter,
  google: googleAdapter,
};

/** Binds a provider's configured endpoint, headers and idle limit: its key must not go to the family's public host. */
function bindEndpoint(adapter: ProviderAdapter, config: ProviderConfig): ProviderAdapter {
  if (!config.baseUrl && !config.headers && config.streamIdleMs === undefined) return adapter;
  return {
    ...adapter,
    ...(config.streamIdleMs === undefined ? {} : { streamIdleMs: config.streamIdleMs }),
    stream: (request, http) =>
      adapter.stream(
        {
          ...request,
          baseUrl: request.baseUrl ?? config.baseUrl,
          headers: { ...config.headers, ...request.headers },
        },
        http,
      ),
  };
}

/** A provider config's inputs to the key lookup. Each daemon lookup spreads them, so none can miss one. */
export function keySourcesFor(
  providerId: string,
  providers: Record<string, ProviderConfig>,
): {
  declaredEnv: string[] | undefined;
  oauthClientId: string | undefined;
  oauthBaseUrl: string | undefined;
} {
  const config = providers[providerId];
  return {
    declaredEnv: config?.env,
    oauthClientId: config?.oauth?.clientId,
    oauthBaseUrl: config?.oauth?.baseUrl,
  };
}

export interface AgentDaemonOptions {
  workspaceRoot: string;
  instanceFile: string;
  /** How long to stay alive after the last client disconnects before exiting. */
  idleLingerMs?: number;
  /** The linger also runs from the start: a daemon that no client reaches (its starter died) then leaves. */
  idleFromStart?: boolean;
  /** Defaults to the real built-in adapters; tests substitute fakes here. */
  adapterFor?: (provider: string) => ProviderAdapter;
  http?: HttpClient;
  /** Defaults to the real P4 built-in set (read/write/edit/bash/grep/glob/
   *  fetch/todo); tests substitute a smaller fake set here. */
  tools?: CoreToolSpec[];
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
 * interactive gate. Allowlists aren't derived: `ask`/`allow` ordering is the
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

export interface TeamBudgets {
  perAgentUsd?: number;
  teamUsd?: number;
  dailyUsd?: number;
  monthlyUsd?: number;
}

/** Hard caps: throw before dispatch when a budget is already spent. */
export function checkTeamBudgets(params: {
  budgets?: TeamBudgets;
  perAgentSpend: ReadonlyMap<string, number>;
  teamTotal: number;
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
  const teamUsd = params.budgets?.teamUsd;
  if (teamUsd !== undefined && params.teamTotal >= teamUsd) {
    throw new Error(`team budget exceeded: ${params.teamTotal} >= ${teamUsd}`);
  }
}

interface HookModelOptions {
  config: Config;
  providers: Record<string, ProviderConfig>;
  adapterFor: (provider: string) => ProviderAdapter;
  http: HttpClient;
  getKeychain: () => Promise<KeychainBackend>;
}

/** The model of a prompt or agent hook: that of the hook, else `small_model`, else `model`, with the key of its provider. */
async function hookModel(opts: HookModelOptions, model: string | undefined) {
  const ref = parseModelRef(model ?? opts.config.small_model ?? opts.config.model ?? "");
  if (!ref) throw new Error("a prompt hook needs small_model or model in the config");
  const apiKey = await resolveApiKey({
    provider: ref.provider,
    env: process.env,
    keychain: await opts.getKeychain().catch(() => undefined),
    config: opts.providers[ref.provider]?.apiKey,
    ...keySourcesFor(ref.provider, opts.providers),
  });
  if (!apiKey) throw new Error(`a prompt hook has no key for ${ref.provider}`);
  return { ref, apiKey };
}

/** The reply of the model of a prompt hook, in one request. */
export function promptHookModel(opts: HookModelOptions): NonNullable<HookRunOptions["askModel"]> {
  return async (prompt, model, signal) => {
    const { ref, apiKey } = await hookModel(opts, model);
    let text = "";
    const messages: Message[] = [{ role: "user", content: [{ type: "text", text: prompt }] }];
    // Room for the thinking of a reasoning model before its short answer.
    for await (const event of opts
      .adapterFor(ref.provider)
      .stream({ model: ref.model, apiKey, messages, maxTokens: 2048, signal }, opts.http)) {
      if (event.type === "text_delta") text += event.text;
    }
    return text;
  };
}

/** The last reply of an agent hook: a turn of at most 50 steps with the read tools of the session, and no hooks. */
export function agentHookModel(
  opts: HookModelOptions & {
    schedulerFor: (provider: string) => Scheduler;
    toolsFor: (sessionId: string | undefined) => Promise<CoreToolSpec[]>;
  },
): NonNullable<HookRunOptions["askAgent"]> {
  return async (prompt, model, signal, sessionId) => {
    const { ref, apiKey } = await hookModel(opts, model);
    const result = await runTurn(opts.adapterFor(ref.provider), opts.schedulerFor(ref.provider), opts.http, {
      identity: { type: "agent", name: "hook" },
      capabilities: FULL_CAPABILITIES,
      systemPrompt:
        "You check a condition for a hook of a coding agent. You can only read. Answer as the task asks.",
      tools: await opts.toolsFor(sessionId),
      model: ref.model,
      apiKey,
      session: [{ role: "user", content: [{ type: "text", text: prompt }] }],
      maxToolIterations: 50,
      signal,
    });
    const last = result.messages.findLast((message) => message.role === "assistant");
    return (last?.content ?? []).flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n");
  };
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

/**
 * Wires the RPC transport to the agent loop: this is the actual `agencyd`
 * body, spawned as a separate process by `ensureDaemon`'s caller and shared
 * by every client (TUI, headless, SDK) that attaches to this workspace root.
 */

export interface ActiveTurnMeta {
  capabilities: Capabilities;
  tools: CoreToolSpec[];
  sessionId: string;
  provider: string;
  model: string;
  apiKey: string;
  /** ISO time of the start of the turn, for the list of active turns. */
  startedAt: string;
  budget?: Budget;
  taskDepth?: number;
  /** The mode of the run: an agent that this turn dispatches answers its asks with it. */
  permissionMode?: PermissionMode;
}

export interface ChildTraceSpec {
  sessionsDir: string;
  sessionId: string;
  traceId: string;
  provider: string;
  model: string;
}

export interface DaemonContext {
  options: AgentDaemonOptions;
  config: Config;
  providers: Record<string, ProviderConfig>;
  logger: Logger;
  eventBus: EventBus;
  telemetry: Telemetry;
  http: HttpClient;
  redactor: Redactor;
  adapterFor: (provider: string) => ProviderAdapter;
  schedulerFor: (provider: string) => Scheduler;
  todoStore: SessionStore;
  boardStore: BoardStore;
  /** Standing wake interests: handles woken on scoped ready_for_review. */
  wakeInterests: WakeRegistry;
  dispatchLog: DispatchStateStore;
  inboxStore: InboxStore;
  channelStore: ChannelStore;
  choiceLog: ChoiceLog;
  warnPersistence: (action: string, error: unknown) => void;
  createTraceRecorder: (trace: ChildTraceSpec) => TraceRecorder | undefined;
  sessionScopes: Map<string, SessionScope>;
  getOrCreateScope: (sessionId: string, handle?: string) => Promise<SessionScope>;
  teamRegistry: AgentRegistry;
  pluginAgents: Array<{ pluginId: string; agent: PluginAgentContribution }>;
  pluginCommands: Array<{ pluginId: string; command: PluginCommandContribution }>;
  trustStore: import("@agency/guard").TrustStore;
  pluginInstructions: readonly string[];
  /** The notes file of the `memory` tool; absent when `memory` of the config is false. */
  memoryFile?: string;
  /** Shell hooks of the config: the turn handler runs the prompt and session events itself. */
  commandHooks: import("@agency/core").CommandHooks;
  hookRun: import("@agency/core").HookRunOptions;
  teamContexts: Map<string, TeamContext>;
  teamFor: (parentSessionId: string) => TeamContext;
  sessionInboxes: Map<string, Message[]>;
  gate: PermissionsGate;
  gateForAgent: (handle: string) => PermissionsGate;
  isReadOnlyAgent: (handle: string) => boolean;
  capabilitiesForAgent: (agentGate: PermissionsGate, tools: CoreToolSpec[]) => Capabilities;
  gateForSession: (sessionId: string) => PermissionsGate;
  defaultCapabilitiesForSession: (sessionId?: string) => Promise<Capabilities>;
  defaultCapabilitiesSync: Capabilities;
  approvalsFor: (sessionId: string) => ApprovalManager;
  approvalManagers: Map<string, ApprovalManager>;
  /** Pre-turn tips per session, pushed by session_send and popped by undo_run. */
  turnCheckpoints: Map<string, Array<string | null>>;
  /** First-class session budgets: set by session_create, refreshed by session_send. */
  sessionBudgets: Map<string, Budget>;
  /** Daemon-wide daily and monthly hard-cap ledger, persisted under sessions. */
  spendLedger: import("@agency/telemetry").SpendLedger;
  /** Per-task turn ledger, persisted as JSONL under sessions; absent in older stubs. */
  taskLedger?: import("./task-ledger.ts").TaskUsageTracker;
  /** Pre-integration workspace captures per lead session, restored by undo_run team scope. */
  teamCheckpoints: Map<string, import("@agency/core").IntegrationCheckpoint>;
  /** Team-scoped MCP pools: one shared-process pool per parent session. */
  teamMcpPools: Map<string, import("@agency/tools").TeamMcpPool>;
  /** Merged catalog models with config overrides (offline, never fetched). */
  listModels: () => ModelInfo[];
  activeControllers: Map<string, AbortController>;
  turnOwners: Map<string, string>;
  activeTurnMeta: Map<string, ActiveTurnMeta>;
  /** For each session, the environment block of its first turn. */
  sessionEnvironments: EnvironmentStore;
  commands: CommandTemplate[];
  catalogModel: (provider: string, model: string) => ModelInfo | undefined;
  learnModel: (provider: string, model: string, http: HttpClient) => Promise<void>;
  resolveAgentModel: (provider: string, model?: string) => string;
  getKeychain: () => Promise<KeychainBackend | undefined>;
  configFingerprint: { check(): boolean };
  broadcast: (event: string, payload: unknown) => void;
  sandbox: SandboxBackend;
  identity: CallerIdentity;
  shellLabel: string;
  todoSessionsDir: string;
  builtinsMode: boolean;
  tools: ToolsToolSpec[];
}

export interface EnvironmentStore {
  get(sessionId: string): string | undefined;
  set(sessionId: string, block: string): void;
}

/** The environment blocks of the sessions, in memory and in a file next to each session, so a block outlives the daemon. */
export function sessionEnvironmentStore(sessionsDir: string): EnvironmentStore {
  const memory = new Map<string, string>();
  // The id of a session comes from the caller: only a plain name becomes a file name.
  const fileOf = (sessionId: string): string | undefined =>
    /^[\w-][\w.-]*$/.test(sessionId) ? join(sessionsDir, `${sessionId}.environment.txt`) : undefined;
  return {
    get(sessionId) {
      const known = memory.get(sessionId);
      if (known !== undefined) return known;
      const file = fileOf(sessionId);
      try {
        const block = file === undefined ? "" : readFileSync(file, "utf8");
        if (block !== "") memory.set(sessionId, block);
      } catch {}
      return memory.get(sessionId);
    },
    set(sessionId, block) {
      if (memory.get(sessionId) === block) return;
      memory.set(sessionId, block);
      const file = fileOf(sessionId);
      try {
        if (file !== undefined) {
          mkdirSync(sessionsDir, { recursive: true });
          writeFileSync(file, block);
        }
      } catch {}
    },
  };
}

export function resolveSystemPrompt(params: RunTurnParams, options: ResolveSystemPromptOptions): string {
  return resolvePrompt(params, options).text;
}

export function resolvePrompt(
  params: RunTurnParams,
  options: ResolveSystemPromptOptions,
): { text: string; segments: CacheSegment[] } {
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
  const stored = params.sessionId === undefined ? undefined : options.environments?.get(params.sessionId);
  // A block of another day has the wrong date, and the cache of the provider is gone by then.
  const kept = stored?.includes(`date: ${environmentDate(options.now ?? new Date())}\n`) ? stored : undefined;
  const context =
    parts?.context === false
      ? undefined
      : (kept ??
        buildEnvironmentBlock(
          gatherEnvironmentInfo({
            cwd: options.workspaceRoot,
            now: options.now,
            git: options.git,
            shell: options.shellLabel,
          }),
        ));
  if (context !== undefined && params.sessionId !== undefined)
    options.environments?.set(params.sessionId, context);

  const composed = composeSystemPrompt({
    base: composeFromParts ? (identity ?? DEFAULT_SYSTEM_PROMPT) : params.systemPrompt,
    familyPresetOverlay: composeFromParts ? role : undefined,
    instructions: instructions ?? [
      ...projectInstructions(options),
      ...(options.pluginInstructions ?? []),
      ...memoryInstructions(options.memoryFile),
    ],
    toolDescriptions: [],
    context,
  });

  const reminders: SystemReminder[] = [...(params.systemReminders ?? [])];
  if (options.mcpFailures) {
    for (const [name, reason] of options.mcpFailures) reminders.push(mcpServerDownReminder(name, reason));
  }
  const final = withPromptVersion(withSystemReminders(composed, reminders));
  return { text: final.text, segments: final.segments };
}
