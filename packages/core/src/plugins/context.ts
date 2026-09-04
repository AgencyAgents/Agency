import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { Capabilities } from "@agency/guard";
import type { EventBus } from "../events.ts";
import { configDir } from "../paths.ts";
import type { LoadedPlugin, PluginHookContext } from "./types.ts";

/**
 * Tier a plugin was loaded from, in injection priority order: project
 * `.agency/plugins/` wins over user config `plugins/`, which wins over npm
 * packages. `PLUGIN_TIERS_IN_ORDER` is the canonical order — discovery in
 * `loader.ts` and every collector here must follow it so prompt injection is
 * deterministic for the same workspace.
 */
export type PluginTier = "project" | "user" | "npm";

export const PLUGIN_TIERS_IN_ORDER: readonly PluginTier[] = ["project", "user", "npm"];

/**
 * Per-contribution read cap. Mirrors `DEFAULT_MAX_INSTRUCTION_BYTES` in
 * `prompt/instructions.ts` (plugin AGENTS.md is the same repo-controlled
 * injection surface, so the same blow-the-prompt hazard applies) without
 * importing it — plugins must not pull the whole prompt module graph.
 */
export const DEFAULT_MAX_PLUGIN_INSTRUCTION_BYTES = 64 * 1024;

function truncateText(text: string, maxBytes: number, label: string): string {
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes <= maxBytes) return text;
  // Cut at a UTF-8 character boundary: back up over continuation bytes.
  const buf = Buffer.from(text, "utf8").subarray(0, maxBytes);
  let end = buf.length;
  while (end > 0 && ((buf[end - 1] ?? 0) & 0xc0) === 0x80) end -= 1;
  // Never split a 2-4 byte leader: if the last byte starts a multi-byte
  // sequence whose continuation bytes were cut, drop the leader too.
  while (end > 0) {
    const last = buf[end - 1] ?? 0;
    let width = 1;
    if ((last & 0x80) === 0) width = 1;
    else if ((last & 0xe0) === 0xc0) width = 2;
    else if ((last & 0xf0) === 0xe0) width = 3;
    else if ((last & 0xf8) === 0xf0) width = 4;
    else break;
    if (buf.length - (end - 1) < width) end -= 1;
    break;
  }
  return `${buf.toString("utf8", 0, end)}\n\n[plugin instruction truncated to ${maxBytes} bytes: ${label}]`;
}

/**
 * Capability-scoped copy for one plugin. The loader passes a single base
 * object for the whole process — handing the same reference to every plugin
 * would let one plugin's `ctx.capabilities.tools.push(...)` (or a sloppy
 * `as unknown as {tools: string[]}` cast) widen every other plugin's rights.
 * This clones each axis and freezes the result, so a plugin can neither
 * escalate itself nor downgrade its neighbors. `pluginId` is reserved for
 * future per-plugin narrowing (e.g. an allowlist); today every plugin gets
 * the same scope, isolated.
 */
export function scopeCapabilitiesForPlugin(base: Capabilities, _pluginId: string): Capabilities {
  const scoped: Capabilities = {
    tools: base.tools === "*" ? "*" : Object.freeze([...base.tools]),
    pathScopes: base.pathScopes === "*" ? "*" : Object.freeze([...base.pathScopes]),
    network:
      base.network === "*" || base.network === "none" ? base.network : Object.freeze([...base.network]),
  };
  return Object.freeze(scoped);
}

/**
 * Builds the hook context for one plugin: per-plugin identity plus a
 * capability-scoped, frozen copy. Every hook invocation for `pluginId` must
 * receive a context from here — never a shared literal — so identity can't
 * be spoofed across plugins and capabilities can't leak.
 */
export function createPluginHookContext(
  bus: EventBus,
  baseCapabilities: Capabilities,
  pluginId: string,
  workspaceRoot: string,
): PluginHookContext {
  const ctx: PluginHookContext = {
    bus,
    capabilities: scopeCapabilitiesForPlugin(baseCapabilities, pluginId),
    identity: { type: "plugin", id: pluginId },
    workspaceRoot,
  };
  return Object.freeze(ctx);
}

/**
 * Error-isolation wrapper for one hook handler. A throwing plugin must never
 * break the bus loop or sibling plugins: errors are logged with plugin + hook
 * identity and swallowed, and the wrapper itself never rejects. (The EventBus
 * also isolates, but defense in depth matters here — a future direct-call
 * path through `definition.hooks` must stay safe too.)
 */
export function wrapHookHandler(
  pluginId: string,
  hookName: string,
  handler: (payload: unknown, ctx: PluginHookContext) => unknown,
  ctx: PluginHookContext,
): (payload: unknown) => Promise<void> {
  return async (payload: unknown) => {
    try {
      await handler(payload, ctx);
    } catch (err) {
      console.error(`[plugins] hook "${hookName}" in plugin "${pluginId}" threw:`, err);
    }
  };
}

/** One plugin's AGENTS.md contribution, already tier-tagged for ordering. */
export interface PluginAgentsContribution {
  id: string;
  tier: PluginTier;
  texts: string[];
}

/**
 * Normalizes a plugin definition's `agentsMd` export (string | string[]) into
 * capped texts. Non-string entries are skipped, never thrown on — a sloppy
 * export must degrade to "no instructions", not to a failed plugin load.
 */
export function collectPluginAgentsTexts(
  definition: { agentsMd?: unknown },
  maxBytes: number,
  label: string,
): string[] {
  const raw = (definition as { agentsMd?: unknown }).agentsMd;
  if (raw === undefined) return [];
  const candidates = Array.isArray(raw) ? raw : [raw];
  const out: string[] = [];
  for (const c of candidates) {
    if (typeof c !== "string" || c.length === 0) continue;
    out.push(truncateText(c, maxBytes, label));
  }
  return out;
}

/**
 * Hierarchical AGENTS.md injection: walks `plugins` in load order (which the
 * loader guarantees is project → user → npm) and concatenates each plugin's
 * contribution. One plugin's bad export is isolated — it contributes nothing
 * and the rest still inject. Returns the ordered texts ready to append after
 * `loadInstructions()` output:
 * `[...loadInstructions(store, root), ...collectPluginInstructions(result.plugins)]`.
 */
export function collectPluginInstructions(
  plugins: LoadedPlugin[],
  options: { maxBytes?: number } = {},
): string[] {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_PLUGIN_INSTRUCTION_BYTES;
  const out: string[] = [];
  for (const p of plugins) {
    try {
      out.push(...collectPluginAgentsTexts(p.definition as { agentsMd?: unknown }, maxBytes, p.id));
    } catch (err) {
      console.error(`[plugins] failed to collect instructions from plugin "${p.id}":`, err);
    }
  }
  return out;
}

function readFileCapped(file: string, maxBytes: number): string {
  const raw = readFileSync(file, "utf8");
  return truncateText(raw, maxBytes, basename(file));
}

/**
 * Sibling-file injection for one file-loaded plugin: `<base>.agents.md` then
 * `<base>.md` next to the plugin file (e.g. `hello.js` + `hello.md`). Missing
 * files contribute nothing; unreadable files are isolated per plugin. Returns
 * texts in sibling-priority order.
 */
export function readSiblingAgentsMd(pluginFilePath: string, options: { maxBytes?: number } = {}): string[] {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_PLUGIN_INSTRUCTION_BYTES;
  const out: string[] = [];
  const stripped = pluginFilePath.replace(/\.(m?js|cjs|ts|mts)$/, "");
  for (const candidate of [`${stripped}.agents.md`, `${stripped}.md`]) {
    if (candidate === pluginFilePath) continue;
    if (!existsSync(candidate)) continue;
    try {
      const text = readFileCapped(candidate, maxBytes);
      if (text.length > 0) out.push(text);
    } catch (err) {
      console.error(`[plugins] failed to read plugin instructions from ${candidate}:`, err);
    }
  }
  return out;
}

/** Tier directories in injection order for a workspace. */
export function resolvePluginTierDirs(
  workspaceRoot: string,
  configDirOverride?: string,
): Array<{ tier: PluginTier; dir: string }> {
  return [
    { tier: "project", dir: join(workspaceRoot, ".agency", "plugins") },
    { tier: "user", dir: join(configDirOverride ?? configDir(), "plugins") },
  ];
}

/**
 * Tier-level file injection in hierarchical order: `<tierDir>/AGENTS.md` for
 * the project tier first, then the user tier. (npm packages have no shared
 * tier dir — their contributions travel via the `agentsMd` export, ordered by
 * load position.) Missing files are skipped; unreadable ones are isolated.
 */
export function collectPluginTierFiles(
  workspaceRoot: string,
  configDirOverride?: string,
  options: { maxBytes?: number } = {},
): string[] {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_PLUGIN_INSTRUCTION_BYTES;
  const out: string[] = [];
  for (const { dir } of resolvePluginTierDirs(workspaceRoot, configDirOverride)) {
    const candidate = join(dir, "AGENTS.md");
    if (!existsSync(candidate)) continue;
    try {
      const text = readFileCapped(candidate, maxBytes);
      if (text.length > 0) out.push(text);
    } catch (err) {
      console.error(`[plugins] failed to read plugin tier instructions from ${candidate}:`, err);
    }
  }
  return out;
}
