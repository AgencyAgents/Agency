import type { EventBus } from "../events.ts";
import type { Capabilities, CallerIdentity } from "@agency/guard";
import type { ToolSpec } from "../loop.ts";

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
] as const;

export type HookName = (typeof HOOK_NAMES)[number];

export interface PluginHookContext {
  bus: EventBus;
  capabilities: Capabilities;
  identity: CallerIdentity;
  workspaceRoot: string;
}

export type HookHandler = (payload: unknown, ctx: PluginHookContext) => void | Promise<void>;

export interface PluginDefinition {
  id: string;
  hooks?: Record<string, HookHandler>;
  tools?: ToolSpec[];
}

export interface LoadedPlugin {
  id: string;
  path: string;
  definition: PluginDefinition;
  unsubscribes: Array<() => void>;
}

export function isValidHookName(name: string): boolean {
  return (HOOK_NAMES as readonly string[]).includes(name) || name.includes("*") || name === "*";
}
