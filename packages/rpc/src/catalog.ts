/**
 * Canonical RPC surface and event catalog behind `/doc` and the SDK.
 * One source of truth: the gateway serves it, sdk-gen emits from it,
 * and the contract test fails when a handler is missing from it.
 */
export const METHOD_DOCS: Record<string, string> = {
  run_turn: "Run one model turn over caller-owned messages.",
  cancel_turn: "Abort an in-flight turn and refuse its pending asks.",
  session_send: "Daemon-owned turn: send text, history and usage stay server-side.",
  session_show: "Read a session through the single SessionProjector view.",
  session_list: "List daemon-known sessions with title and tip.",
  session_create: "Create an empty session, id generated when omitted.",
  session_export: "Return a session's raw entries verbatim, unknown types included.",
  session_rename: "Move a session history to a new id (clone plus delete).",
  session_delete: "Drop a session scope, approvals, and stored entries.",
  session_fork: "Branch a session at a tip inside the same file.",
  session_clone: "Copy a session file to an independent new id.",
  session_message: "Queue mid-turn steering text drained per tool iteration.",
  models_list: "List catalog models merged with config overrides.",
  providers_list: "List providers with defaults, connectivity, and liveness.",
  config_get: "Read daemon config, secrets redacted, or one top-level key.",
  config_set: "Set one runtime-safe config key in memory until restart.",
  permissions_list: "Show the permission maps plus effective offered tools.",
  todo_read: "Read the latest persisted todo_state for a session.",
  todo_write: "Persist a todo_state entry for a session.",
  cost_report: "Sum usage entries plus trace spans per session and agent (Phase 9 adds budgets and caps).",
  undo_run: "Roll a session back to its pre-turn checkpoint (Phase 8 generalizes to team runs).",
  undo: "Undo the last snapshot-backed file change.",
  redo: "Redo a snapshot-backed file change.",
  prompt_inspect: "Resolve the system prompt without running a turn.",
  approval_respond: "Answer a pending approval ask once, always, or reject.",
  agent_message: "Deliver a message to an agent mailbox.",
  agents_list: "List team agents with state, session, and cost.",
  agents_upsert: "Write an agent file and refresh the registry entry.",
  agent_inspect: "Timeline, step, or reasoning view over an agent's recorded spans.",
  activity_graph: "Delegation DAG of agents plus tasks with state and cost.",
  board_read: "List board items with status, claim, and scope, plus the event log.",
  board_claim: "Accept, decline, counter, or escalate a board item.",
  task_file: "File a board item with goal, criteria, scope, and budget.",
  inbox_send: "Post a typed message to a teammate inbox.",
  channel_read: "Pull shared channel posts after a cursor.",
  owners_read: "Resolve path owners from the .agency/owners map.",
  decisions_read: "Read the shared choice log entries.",
  report_get: "Render the structured team report with outcome and cost.",
  agent_history: "Read an agent child session history.",
  team_status: "Team states, todo, and totals for a parent session.",
  team_open: "Open a team behind approval when the goal needs parallel specialists.",
  team_stop: "Stop a team run and reject its pending asks.",
  agent_stop: "Stop one team agent and idle its sessions.",
  dispatch_compare: "Fan out one prompt to two agents and compare.",
  plan_approve: "Record a human approval for a plan file.",
  mcp_status: "MCP server failures for a session scope.",
  lsp_status: "Language server statuses for a session scope.",
  commands_list: "List available slash command templates.",
  commands_expand: "Expand a slash command template with args.",
  command_run: "Resolve /name to a built-in handler or markdown template.",
  trace_get: "Load trace spans, optionally for one turn, as list plus tree.",
  trace_replay: "Re-run a recorded turn and diff the messages.",
  trace_export: "Ship spans to the configured OTLP endpoint.",
};

/** Every method the daemon answers, derived from the catalog keys. */
export const RPC_METHODS: readonly string[] = Object.keys(METHOD_DOCS);

export interface EventDoc {
  name: string;
  description: string;
}

/**
 * Versioned event catalog served at `/doc` under x-agency.events.
 * Names only: payload shapes live beside the emitters and are re-exported
 * by the SDK as TypeScript types (sdk-gen fails on a name without a type).
 */
export const EVENT_CATALOG: readonly EventDoc[] = [
  { name: "turn.*", description: "Per-turn deltas, tool calls, and completion." },
  { name: "text_delta", description: "Model text chunk inside a turn stream." },
  { name: "thinking_delta", description: "Reasoning chunk inside a turn stream." },
  { name: "tool_start", description: "A tool call began." },
  { name: "tool_result", description: "A tool call settled." },
  { name: "turn_complete", description: "A turn finished with stop reason and usage." },
  { name: "cost_meter", description: "Live turn cost plus run totals and per-agent spend." },
  { name: "cost_report", description: "Per-run totals with tokens, hit rate, and per-agent breakdown." },
  { name: "budget_exceeded", description: "A turn stopped on a budget cap." },
  { name: "heartbeat", description: "Turn liveness marker on silent stretches." },
  { name: "fallback", description: "Turn retried on the fallback model." },
  { name: "approval_requested", description: "An ask is pending; answer via approval_respond." },
  { name: "session.*", description: "Per-session broadcasts such as session_message." },
  { name: "session_message", description: "Steering text queued into a session inbox." },
  { name: "session.created", description: "A session file was created." },
  { name: "session.compacted", description: "A session compacted to a new tip." },
  { name: "session.start", description: "A turn opened on a fresh session." },
  { name: "session.idle", description: "A session went idle after its turn." },
  { name: "permission.asked", description: "The gate presented an ask." },
  { name: "permission.replied", description: "An ask settled with decision and reason." },
  { name: "prompt.submit", description: "A turn prompt was submitted." },
  { name: "model.fallback", description: "Provider fallback on the event bus." },
  { name: "state", description: "Connect-time snapshot: turns, approvals, agents, cost." },
  { name: "sync-entry", description: "One replayed session entry from sync-events." },
  { name: "sync-complete", description: "End of a sync-events replay with entry count." },
];

/** Every catalogued event name. */
export const GATEWAY_EVENTS: readonly string[] = EVENT_CATALOG.map((e) => e.name);

/** Per-key ring bound and SSE retry hint served on connect. */
export const EVENT_RING_SIZE = 256;
export const EVENT_RETRY_MS = 3_000;
