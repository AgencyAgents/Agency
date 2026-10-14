/**
 * Fetches the gateway /doc and emits the typed SDK surface.
 * Run: bun scripts/sdk-gen.ts --url http://127.0.0.1:PORT/doc --out packages/sdk/src/generated.ts
 */
import { writeFileSync } from "node:fs";

interface DocMethod {
  name: string;
  description: string;
}

interface DocEvent {
  name: string;
  description: string;
}

/** Payload type per catalogued event; a missing entry fails generation loudly. */
const EVENT_TYPES: Record<string, string> = {
  // biome-ignore lint/suspicious/noTemplateCurlyInString: emitted SDK code, not a template
  "turn.*": "export type TurnChannel = `turn.${string}`;",
  text_delta: "export interface TextDeltaEvent { type: string; text: string; }",
  thinking_delta: "export interface ThinkingDeltaEvent { type: string; text: string; }",
  tool_start:
    "export interface ToolStartEvent { type: string; id: string; name: string; input?: Record<string, unknown>; }",
  tool_result:
    "export interface ToolResultEvent { type: string; id: string; content: string; isError: boolean; }",
  turn_complete:
    "export interface TurnCompleteEvent { type: string; stopReason: string; usage: EventUsage; }",
  cost_meter:
    "export interface CostMeterEvent { type: string; sessionId: string; turnCostUsd: number; runTotalUsd: number; runCacheHitRate: number; perAgent: Record<string, number>; }",
  cost_report:
    "export interface CostReportEvent { type: string; totalUsd: number; tokens: number; cacheHitRate: number; perAgent: Record<string, unknown>; }",
  budget_exceeded:
    "export interface BudgetExceededEvent { type: string; spentTokens: number; spentCostUsd: number; }",
  heartbeat: "export interface HeartbeatEvent { type: string; }",
  fallback: "export interface FallbackEvent { type: string; from: string; to: string; reason: string; }",
  approval_requested:
    "export interface ApprovalRequestedEvent { type: string; requestId: string; sessionId: string; turnId: string; riskTier: string; source: string; argsSummary: string; request: ApprovalRequest; }",
  // biome-ignore lint/suspicious/noTemplateCurlyInString: emitted SDK code, not a template
  "session.*": "export type SessionChannel = `session.${string}`;",
  session_message: "export interface SessionMessageEvent { type: string; sessionId: string; }",
  "session.created": "export interface SessionCreatedEvent { sessionId: string; }",
  "session.compacted": "export interface SessionCompactedEvent { sessionId: string; tipId: string; }",
  "session.start": "export interface SessionStartEvent { sessionId: string; workspaceRoot: string; }",
  "session.idle": "export interface SessionIdleEvent { sessionId?: string; }",
  "permission.asked": "export interface PermissionAskedEvent { tool: string; decision: string; }",
  "permission.replied":
    "export interface PermissionRepliedEvent { tool: string; decision: string; closeReason?: string; }",
  "prompt.submit": "export interface PromptSubmitEvent { sessionId: string; prompt: string; }",
  "model.fallback": "export interface ModelFallbackEvent { from: string; to: string; reason: string; }",
  state:
    "export interface StateEvent { turns: LiveTurn[]; approvals: OutstandingApproval[]; agents: AgentRow[]; cost: CostSnapshot; board: unknown; session?: unknown; }",
  "sync-entry": "export interface SyncEntryEvent { entry: Record<string, unknown>; }",
  "sync-complete": "export interface SyncCompleteEvent { count: number; }",
};

export interface AgencyDoc {
  protocolVersion: number;
  methods: DocMethod[];
  events: DocEvent[];
}

export async function fetchAgencyDoc(docUrl: string): Promise<AgencyDoc> {
  const res = await fetch(docUrl);
  if (!res.ok) throw new Error(`GET ${docUrl} failed: ${res.status}`);
  const doc = (await res.json()) as {
    "x-agency"?: { protocolVersion?: unknown; methods?: unknown; events?: unknown };
  };
  const catalog = doc["x-agency"];
  if (!catalog || typeof catalog.protocolVersion !== "number") {
    throw new Error("doc has no x-agency.protocolVersion: regenerate against a Phase 10a gateway");
  }
  const methods = catalog.methods as DocMethod[];
  const events = catalog.events as DocEvent[];
  if (!Array.isArray(methods) || methods.length === 0) throw new Error("doc has no x-agency.methods");
  if (!Array.isArray(events) || events.length === 0) throw new Error("doc has no x-agency.events");
  return { protocolVersion: catalog.protocolVersion, methods, events };
}

/** Single-line interface declarations render multi-line, matching biome format. */
function emitDecl(decl: string): string {
  const match = decl.match(/^export interface (\w+) \{(.*)\}$/);
  if (!match) return decl;
  const fields = match[2]
    ?.split(";")
    .map((f) => f.trim())
    .filter((f) => f.length > 0);
  return `export interface ${match[1]} {\n${(fields ?? []).map((f) => `  ${f};`).join("\n")}\n}`;
}

export function renderSdk(doc: AgencyDoc): string {
  const missing = doc.events.map((e) => e.name).filter((name) => !(name in EVENT_TYPES));
  if (missing.length > 0) {
    throw new Error(`no SDK event type for: ${missing.join(", ")} (add to EVENT_TYPES)`);
  }
  const methods = [...doc.methods].sort((a, b) => (a.name < b.name ? -1 : 1));
  const methodUnion = methods.map((m) => `  | "${m.name}"`).join("\n");
  const surfaceMethods = methods
    .map((m) => `  /** ${m.description} */\n  ${m.name}(params?: Record<string, unknown>): Promise<unknown>;`)
    .join("\n");
  const surfaceImpl = methods
    .map((m) => `    ${m.name}: (params) => call("${m.name}", params ?? {}),`)
    .join("\n");
  const eventDecls = doc.events.map((e) => emitDecl(EVENT_TYPES[e.name] ?? "")).join("\n");
  return `/**
 * GENERATED from GET /doc (protocol ${doc.protocolVersion}): do not edit.
 * Regenerate with: bun scripts/sdk-gen.ts --url http://127.0.0.1:PORT/doc --out packages/sdk/src/generated.ts
 */

/** Wire protocol version this surface was generated against. */
export const SDK_PROTOCOL_VERSION = ${doc.protocolVersion};

/** Every RPC method the gateway serves. */
export type RpcMethod =
${methodUnion};

/** Every event name the gateway may emit over SSE. */
export type GatewayEvent =
${doc.events.map((e) => `  | "${e.name}"`).join("\n")};\n
export interface EventUsage {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens?: number;
  cacheWriteInputTokens?: number;
}

export interface ApprovalRequest {
  tool: string;
  title: string;
  command?: string;
  path?: string;
  riskTier?: string;
  sessionId?: string;
  turnId?: string;
  source?: string;
  argsSummary?: string;
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

${eventDecls}

/** One method per RPC, over any \`call(method, params)\` transport. */
export interface SurfaceClient {
${surfaceMethods}
}

/** Wraps a raw \`call\` (DaemonClient.call or HTTP POST /rpc) with every method. */
export function createSurfaceClient(
  call: (method: string, params: Record<string, unknown>) => Promise<unknown>,
): SurfaceClient {
  return {
${surfaceImpl}
  };
}
`;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const url = args[args.indexOf("--url") + 1];
  const out = args[args.indexOf("--out") + 1];
  if (!url || !out) throw new Error("usage: sdk-gen.ts --url <docUrl> --out <file>");
  const doc = await fetchAgencyDoc(url);
  writeFileSync(out, renderSdk(doc));
  console.log(`wrote ${out}: ${doc.methods.length} methods, ${doc.events.length} events`);
}

if (import.meta.main) await main();
