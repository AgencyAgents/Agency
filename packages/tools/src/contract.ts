import type { CallerIdentity, Capabilities, SandboxBoundary } from "@agency/guard";

export type RiskTier = "safe" | "moderate" | "dangerous";

export interface ToolContext {
  signal: AbortSignal;
}

export interface ToolResult {
  content: string;
  isError?: boolean;
}

/**
 * The full tool contract (R3). `renderCall`/`renderResult` let a tool own its
 * TUI presentation instead of the renderer special-casing every tool by name;
 * they're optional so a bare handler is still a valid tool. `handler`'s
 * signature matches what the agent loop already calls (input, {signal}) so
 * these compose directly as the loop's ToolSpec without any adapter shim.
 */
export interface ToolSpec<Input = Record<string, unknown>> {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  riskTier: RiskTier;
  handler: (input: Input, ctx: ToolContext) => Promise<ToolResult>;
  renderCall?: (input: Input) => string;
  renderResult?: (result: ToolResult) => string;
}

/** Dependencies every built-in factory closes over, bound once per session/daemon. */
export interface ToolDeps {
  identity: CallerIdentity;
  capabilities: Capabilities;
  sandbox: SandboxBoundary;
}
