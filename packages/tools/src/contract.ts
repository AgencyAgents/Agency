import type { ApprovalRequest, CallerIdentity, Capabilities, SandboxBoundary } from "@agency/guard";
import type { ImageBlock } from "@agency/schema";

export type RiskTier = "safe" | "moderate" | "dangerous";

/** What the user answered when a tool (or the gate) asked for approval. */
export type ApprovalResponse = "once" | "always" | "reject";

export interface ToolContext {
  signal: AbortSignal;
  /** Turn that invoked the tool (absent when the caller doesn't track one);
   *  file-mutating tools index their snapshots under it for undo. */
  turnId?: string;
  /** Workspace directory the tool runs in; relative path arguments resolve against it. */
  cwd?: string;
  /** Session this tool call belongs to (session-scoped grants key off it). */
  sessionId?: string;
  /** The provider's tool-call id; correlates asks and results with the call. */
  toolCallId?: string;
  /**
   * Ask the user to approve something this handler wants to do (an out-of-workspace
   * path, a costly dispatch, ...). Resolves once/always/reject; absent when the
   * caller has no approval surface, in which case a tool must fail closed.
   */
  requestApproval?: (request: ApprovalRequest) => Promise<ApprovalResponse>;
}

export interface ToolResult {
  content: string;
  isError?: boolean;
  /**
   * Images to attach alongside the text content (P7 image input): the loop
   * turns these into ImageBlocks on the tool_result message so vision models
   * see what the tool read. Absent for text-only results.
   */
  images?: ImageBlock[];
}

/**
 * The full tool contract (R3). `renderCall`/`renderResult` let a tool own its
 * TUI presentation instead of the renderer special-casing every tool by name;
 * they're optional so a bare handler is still a valid tool. `handler`'s
 * signature matches what the agent loop already calls (input, {signal}) so
 * these compose directly as the loop's ToolSpec without any adapter shim.
 * renderResult receives the call's parsed arguments alongside the result so a
 * renderer can name what produced the output; both must return a single line
 * (transcript frames are line-based), so multi-line content needs collapsing.
 */
export interface ToolSpec<Input = Record<string, unknown>> {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  riskTier: RiskTier;
  handler: (input: Input, ctx: ToolContext) => Promise<ToolResult>;
  renderCall?: (input: Input) => string;
  renderResult?: (result: ToolResult & { input?: Record<string, unknown> }) => string;
}

/** Dependencies every built-in factory closes over, bound once per session/daemon. */
export interface ToolDeps {
  identity: CallerIdentity;
  capabilities: Capabilities;
  sandbox: SandboxBoundary;
}
