/**
 * GENERATED from GET /doc (protocol 2): do not edit.
 * Regenerate with: bun scripts/sdk-gen.ts --url http://127.0.0.1:PORT/doc --out packages/sdk/src/generated.ts
 */

/** Wire protocol version this surface was generated against. */
export const SDK_PROTOCOL_VERSION = 2;

/** Every RPC method the gateway serves. */
export type RpcMethod =
  | "agent_history"
  | "agent_message"
  | "agents_list"
  | "approval_respond"
  | "cancel_turn"
  | "commands_expand"
  | "commands_list"
  | "config_get"
  | "config_set"
  | "cost_report"
  | "dispatch_compare"
  | "lsp_status"
  | "mcp_status"
  | "models_list"
  | "permissions_list"
  | "plan_approve"
  | "prompt_inspect"
  | "providers_list"
  | "redo"
  | "run_turn"
  | "session_clone"
  | "session_create"
  | "session_delete"
  | "session_export"
  | "session_fork"
  | "session_list"
  | "session_message"
  | "session_rename"
  | "session_send"
  | "session_show"
  | "team_status"
  | "team_stop"
  | "todo_read"
  | "todo_write"
  | "trace_export"
  | "trace_get"
  | "trace_replay"
  | "undo"
  | "undo_run";

/** Every event name the gateway may emit over SSE. */
export type GatewayEvent =
  | "turn.*"
  | "text_delta"
  | "thinking_delta"
  | "tool_start"
  | "tool_result"
  | "turn_complete"
  | "budget_exceeded"
  | "heartbeat"
  | "fallback"
  | "approval_requested"
  | "session.*"
  | "session_message"
  | "session.created"
  | "session.compacted"
  | "session.start"
  | "session.idle"
  | "permission.asked"
  | "permission.replied"
  | "prompt.submit"
  | "model.fallback"
  | "state"
  | "sync-entry"
  | "sync-complete";

export interface EventUsage {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens?: number;
}

export interface ApprovalRequest {
  tool: string;
  title: string;
  command?: string;
  path?: string;
  metadata?: Record<string, unknown>;
}

export interface LiveTurn {
  turnId: string;
  sessionId: string;
  provider: string;
  model: string;
}

export interface OutstandingApproval {
  id: string;
  sessionId: string;
  request: ApprovalRequest;
  turnId?: string;
}

export interface AgentRow {
  handle: string;
  role: string;
  provider: string;
  model: string;
  effort: string;
  state: string;
  sessionId: string;
  costUsd: number;
}

export interface CostSnapshot {
  totalUsd: number;
  bySession: Record<string, number>;
}

export type TurnChannel = `turn.${string}`;
export interface TextDeltaEvent {
  type: string;
  text: string;
}
export interface ThinkingDeltaEvent {
  type: string;
  text: string;
}
export interface ToolStartEvent {
  type: string;
  id: string;
  name: string;
  input?: Record<string, unknown>;
}
export interface ToolResultEvent {
  type: string;
  id: string;
  content: string;
  isError: boolean;
}
export interface TurnCompleteEvent {
  type: string;
  stopReason: string;
  usage: EventUsage;
}
export interface BudgetExceededEvent {
  type: string;
  spentTokens: number;
  spentCostUsd: number;
}
export interface HeartbeatEvent {
  type: string;
}
export interface FallbackEvent {
  type: string;
  from: string;
  to: string;
  reason: string;
}
export interface ApprovalRequestedEvent {
  type: string;
  requestId: string;
  request: ApprovalRequest;
}
export type SessionChannel = `session.${string}`;
export interface SessionMessageEvent {
  type: string;
  sessionId: string;
}
export interface SessionCreatedEvent {
  sessionId: string;
}
export interface SessionCompactedEvent {
  sessionId: string;
  tipId: string;
}
export interface SessionStartEvent {
  sessionId: string;
  workspaceRoot: string;
}
export interface SessionIdleEvent {
  sessionId?: string;
}
export interface PermissionAskedEvent {
  tool: string;
  decision: string;
}
export interface PermissionRepliedEvent {
  tool: string;
  decision: string;
  closeReason?: string;
}
export interface PromptSubmitEvent {
  sessionId: string;
  prompt: string;
}
export interface ModelFallbackEvent {
  from: string;
  to: string;
  reason: string;
}
export interface StateEvent {
  turns: LiveTurn[];
  approvals: OutstandingApproval[];
  agents: AgentRow[];
  cost: CostSnapshot;
  session?: unknown;
}
export interface SyncEntryEvent {
  entry: Record<string, unknown>;
}
export interface SyncCompleteEvent {
  count: number;
}

/** One method per RPC, over any `call(method, params)` transport. */
export interface SurfaceClient {
  /** Read an agent child session history. */
  agent_history(params?: Record<string, unknown>): Promise<unknown>;
  /** Deliver a message to an agent mailbox. */
  agent_message(params?: Record<string, unknown>): Promise<unknown>;
  /** List team agents with state, session, and cost. */
  agents_list(params?: Record<string, unknown>): Promise<unknown>;
  /** Answer a pending approval ask once, always, or reject. */
  approval_respond(params?: Record<string, unknown>): Promise<unknown>;
  /** Abort an in-flight turn and refuse its pending asks. */
  cancel_turn(params?: Record<string, unknown>): Promise<unknown>;
  /** Expand a slash command template with args. */
  commands_expand(params?: Record<string, unknown>): Promise<unknown>;
  /** List available slash command templates. */
  commands_list(params?: Record<string, unknown>): Promise<unknown>;
  /** Read daemon config, secrets redacted, or one top-level key. */
  config_get(params?: Record<string, unknown>): Promise<unknown>;
  /** Set one runtime-safe config key in memory until restart. */
  config_set(params?: Record<string, unknown>): Promise<unknown>;
  /** Sum usage entries plus trace spans per session and agent (Phase 9 adds budgets and caps). */
  cost_report(params?: Record<string, unknown>): Promise<unknown>;
  /** Fan out one prompt to two agents and compare. */
  dispatch_compare(params?: Record<string, unknown>): Promise<unknown>;
  /** Language server statuses for a session scope. */
  lsp_status(params?: Record<string, unknown>): Promise<unknown>;
  /** MCP server failures for a session scope. */
  mcp_status(params?: Record<string, unknown>): Promise<unknown>;
  /** List catalog models merged with config overrides. */
  models_list(params?: Record<string, unknown>): Promise<unknown>;
  /** Show the permission maps plus effective offered tools. */
  permissions_list(params?: Record<string, unknown>): Promise<unknown>;
  /** Record a human approval for a plan file. */
  plan_approve(params?: Record<string, unknown>): Promise<unknown>;
  /** Resolve the system prompt without running a turn. */
  prompt_inspect(params?: Record<string, unknown>): Promise<unknown>;
  /** List providers with defaults, connectivity, and liveness. */
  providers_list(params?: Record<string, unknown>): Promise<unknown>;
  /** Redo a snapshot-backed file change. */
  redo(params?: Record<string, unknown>): Promise<unknown>;
  /** Run one model turn over caller-owned messages. */
  run_turn(params?: Record<string, unknown>): Promise<unknown>;
  /** Copy a session file to an independent new id. */
  session_clone(params?: Record<string, unknown>): Promise<unknown>;
  /** Create an empty session, id generated when omitted. */
  session_create(params?: Record<string, unknown>): Promise<unknown>;
  /** Drop a session scope, approvals, and stored entries. */
  session_delete(params?: Record<string, unknown>): Promise<unknown>;
  /** Return a session's raw entries verbatim, unknown types included. */
  session_export(params?: Record<string, unknown>): Promise<unknown>;
  /** Branch a session at a tip inside the same file. */
  session_fork(params?: Record<string, unknown>): Promise<unknown>;
  /** List daemon-known sessions with title and tip. */
  session_list(params?: Record<string, unknown>): Promise<unknown>;
  /** Queue mid-turn steering text drained per tool iteration. */
  session_message(params?: Record<string, unknown>): Promise<unknown>;
  /** Move a session history to a new id (clone plus delete). */
  session_rename(params?: Record<string, unknown>): Promise<unknown>;
  /** Daemon-owned turn: send text, history and usage stay server-side. */
  session_send(params?: Record<string, unknown>): Promise<unknown>;
  /** Read a session through the single SessionProjector view. */
  session_show(params?: Record<string, unknown>): Promise<unknown>;
  /** Team states, todo, and totals for a parent session. */
  team_status(params?: Record<string, unknown>): Promise<unknown>;
  /** Stop a team run and reject its pending asks. */
  team_stop(params?: Record<string, unknown>): Promise<unknown>;
  /** Read the latest persisted todo_state for a session. */
  todo_read(params?: Record<string, unknown>): Promise<unknown>;
  /** Persist a todo_state entry for a session. */
  todo_write(params?: Record<string, unknown>): Promise<unknown>;
  /** Ship spans to the configured OTLP endpoint. */
  trace_export(params?: Record<string, unknown>): Promise<unknown>;
  /** Load trace spans, optionally for one turn, as list plus tree. */
  trace_get(params?: Record<string, unknown>): Promise<unknown>;
  /** Re-run a recorded turn and diff the messages. */
  trace_replay(params?: Record<string, unknown>): Promise<unknown>;
  /** Undo the last snapshot-backed file change. */
  undo(params?: Record<string, unknown>): Promise<unknown>;
  /** Roll a session back to its pre-turn checkpoint (Phase 8 generalizes to team runs). */
  undo_run(params?: Record<string, unknown>): Promise<unknown>;
}

/** Wraps a raw `call` (DaemonClient.call or HTTP POST /rpc) with every method. */
export function createSurfaceClient(
  call: (method: string, params: Record<string, unknown>) => Promise<unknown>,
): SurfaceClient {
  return {
    agent_history: (params) => call("agent_history", params ?? {}),
    agent_message: (params) => call("agent_message", params ?? {}),
    agents_list: (params) => call("agents_list", params ?? {}),
    approval_respond: (params) => call("approval_respond", params ?? {}),
    cancel_turn: (params) => call("cancel_turn", params ?? {}),
    commands_expand: (params) => call("commands_expand", params ?? {}),
    commands_list: (params) => call("commands_list", params ?? {}),
    config_get: (params) => call("config_get", params ?? {}),
    config_set: (params) => call("config_set", params ?? {}),
    cost_report: (params) => call("cost_report", params ?? {}),
    dispatch_compare: (params) => call("dispatch_compare", params ?? {}),
    lsp_status: (params) => call("lsp_status", params ?? {}),
    mcp_status: (params) => call("mcp_status", params ?? {}),
    models_list: (params) => call("models_list", params ?? {}),
    permissions_list: (params) => call("permissions_list", params ?? {}),
    plan_approve: (params) => call("plan_approve", params ?? {}),
    prompt_inspect: (params) => call("prompt_inspect", params ?? {}),
    providers_list: (params) => call("providers_list", params ?? {}),
    redo: (params) => call("redo", params ?? {}),
    run_turn: (params) => call("run_turn", params ?? {}),
    session_clone: (params) => call("session_clone", params ?? {}),
    session_create: (params) => call("session_create", params ?? {}),
    session_delete: (params) => call("session_delete", params ?? {}),
    session_export: (params) => call("session_export", params ?? {}),
    session_fork: (params) => call("session_fork", params ?? {}),
    session_list: (params) => call("session_list", params ?? {}),
    session_message: (params) => call("session_message", params ?? {}),
    session_rename: (params) => call("session_rename", params ?? {}),
    session_send: (params) => call("session_send", params ?? {}),
    session_show: (params) => call("session_show", params ?? {}),
    team_status: (params) => call("team_status", params ?? {}),
    team_stop: (params) => call("team_stop", params ?? {}),
    todo_read: (params) => call("todo_read", params ?? {}),
    todo_write: (params) => call("todo_write", params ?? {}),
    trace_export: (params) => call("trace_export", params ?? {}),
    trace_get: (params) => call("trace_get", params ?? {}),
    trace_replay: (params) => call("trace_replay", params ?? {}),
    undo: (params) => call("undo", params ?? {}),
    undo_run: (params) => call("undo_run", params ?? {}),
  };
}
