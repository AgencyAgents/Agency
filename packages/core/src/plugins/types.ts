import type { CallerIdentity, Capabilities } from "@agency/guard";
import type { EventBus } from "../events.ts";
import type { ToolSpec } from "../loop.ts";
import type { PluginTier } from "./context.ts";

export const HOOK_NAMES = [
  "event",
  "tool.execute.before",
  "tool.execute.after",
  "session.created",
  "session.compacted",
  "session.idle",
  "file.edited",
  "permission.asked",
  "permission.replied",
  "shell.env",
  "session.start",
  "prompt.submit",
  "subagent.start",
] as const;

export type HookName = (typeof HOOK_NAMES)[number];

export interface PluginHookContext {
  bus: EventBus;
  capabilities: Capabilities;
  identity: CallerIdentity;
  workspaceRoot: string;
}

export type HookHandler = (payload: unknown, ctx: PluginHookContext) => void | Promise<void>;

export interface PluginAgentContribution {
  role: string;
  handle?: string;
  provider?: string;
  model?: string;
  effort?: string;
  tools?: string[];
  permissions?: Record<string, unknown>;
  pathScope?: string | string[];
  prompt?: string;
}

export interface PluginDefinition {
  id: string;
  hooks?: Record<string, HookHandler>;
  tools?: ToolSpec[];
  agents?: PluginAgentContribution[];
  /**
   * Skill-embedded MCP servers, declared per-skill. Raw (unvalidated) map of
   * server name to server config; validated with `parseMcpServers` at spawn
   * time by `startSkillMcpServers` (tools package). Never started at load:
   * spawned on demand scoped to a task and disposed when the task is done,
   * so idle skills cost no processes and contribute no tools (no context bloat).
   */
  mcpServers?: Record<string, unknown>;
  /**
   * Hierarchical AGENTS.md contribution. A plugin may export a string (or
   * array of strings) of extra instructions; the loader injects them in
   * tier order (project → user → npm) after `loadInstructions()` output.
   * Non-string entries are ignored, never fatal.
   */
  agentsMd?: string | string[];
}

export interface LoadedPlugin {
  id: string;
  path: string;
  /** Tier the plugin was loaded from — load/injection order follows project → user → npm. */
  tier: PluginTier;
  definition: PluginDefinition;
  unsubscribes: Array<() => void>;
}

export function isValidHookName(name: string): boolean {
  return (HOOK_NAMES as readonly string[]).includes(name) || name.includes("*") || name === "*";
}
