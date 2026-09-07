import { existsSync, readdirSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { CallerIdentity, Capabilities } from "@agency/guard";
import type { EventBus } from "../events.ts";
import type { Logger } from "../logger.ts";
import type { ToolSpec } from "../loop.ts";
import { configDir } from "../paths.ts";
import type { PluginTier } from "./context.ts";
import {
  collectPluginAgentsTexts,
  collectPluginTierFiles,
  createPluginHookContext,
  DEFAULT_MAX_PLUGIN_INSTRUCTION_BYTES,
  readSiblingAgentsMd,
  wrapHookHandler,
} from "./context.ts";
import { discoverSkills, resolveSkillDirs, skillToPlugin } from "./skill.ts";
import type { LoadedPlugin, PluginDefinition } from "./types.ts";

export interface PluginToolRegistry {
  register(spec: ToolSpec, opts?: { namespace?: string }): void;
  has(name: string): boolean;
  list?(): ToolSpec[];
}

export interface PluginLoaderOptions {
  workspaceRoot: string;
  configDirOverride?: string;
  configPlugins?: string[];
  bus: EventBus;
  logger?: Logger;
  registry?: PluginToolRegistry;
  capabilities?: Capabilities;
  identity?: CallerIdentity;
  /** Per-contribution byte cap for AGENTS.md injection; defaults to `DEFAULT_MAX_PLUGIN_INSTRUCTION_BYTES`. */
  maxInstructionBytes?: number;
}

export interface PluginLoadResult {
  plugins: LoadedPlugin[];
  errors: Array<{ id: string; error: string }>;
  /**
   * Hierarchical AGENTS.md texts in injection order: tier-level AGENTS.md
   * files (project, then user), then per-plugin contributions in load order
   * (project -> user -> npm). Append after `loadInstructions()` output.
   */
  instructions: string[];
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function validateToolSpec(raw: unknown): { valid: boolean; reason?: string } {
  if (!isRecord(raw)) return { valid: false, reason: "tool must be an object" };
  if (typeof raw.name !== "string" || raw.name.length === 0)
    return { valid: false, reason: "tool.name must be non-empty string" };
  if (typeof raw.description !== "string") return { valid: false, reason: "tool.description must be string" };
  if (!isRecord(raw.inputSchema)) return { valid: false, reason: "tool.inputSchema must be object" };
  if (typeof raw.handler !== "function") return { valid: false, reason: "tool.handler must be function" };
  return { valid: true };
}

function extractAgentsMd(raw: unknown): string | string[] | undefined {
  if (typeof raw === "string") return raw.length > 0 ? raw : undefined;
  if (Array.isArray(raw)) {
    const texts = raw.filter((t): t is string => typeof t === "string" && t.length > 0);
    return texts.length > 0 ? texts : undefined;
  }
  return undefined;
}

function extractPluginAgents(raw: unknown): PluginDefinition["agents"] {
  if (!Array.isArray(raw)) return undefined;
  const out: NonNullable<PluginDefinition["agents"]> = [];
  for (const entry of raw) {
    if (!isRecord(entry) || typeof entry.role !== "string" || entry.role.length === 0) continue;
    out.push(entry as unknown as NonNullable<PluginDefinition["agents"]>[number]);
  }
  return out.length > 0 ? out : undefined;
}

function extractPluginCommands(raw: unknown): PluginDefinition["commands"] {
  if (!Array.isArray(raw)) return undefined;
  const out: NonNullable<PluginDefinition["commands"]> = [];
  for (const entry of raw) {
    if (!isRecord(entry) || typeof entry.name !== "string" || entry.name.length === 0) continue;
    if (typeof entry.template !== "string" || entry.template.length === 0) continue;
    out.push(entry as unknown as NonNullable<PluginDefinition["commands"]>[number]);
  }
  return out.length > 0 ? out : undefined;
}

function extractDefinition(rawModule: Record<string, unknown>, id: string): PluginDefinition | undefined {
  // Supports: default export { hooks, tools }, named exports hooks/tools, or direct hooks object
  let source: Record<string, unknown> | undefined;
  if (isRecord(rawModule.default)) {
    source = rawModule.default as Record<string, unknown>;
    // If default itself looks like hooks map (no hooks/tools/mcpServers key but has known hook names or * ), treat it as hooks
    if (!("hooks" in source) && !("tools" in source) && !("mcpServers" in source) && !("agents" in source)) {
      const keys = Object.keys(source);
      if (keys.some((k) => k.includes(".") || k === "event" || k === "*")) {
        const def: PluginDefinition = {
          id,
          hooks: source as Record<string, unknown> as PluginDefinition["hooks"],
        };
        const agentsMd = extractAgentsMd(rawModule.agentsMd ?? source.agentsMd);
        if (agentsMd) def.agentsMd = agentsMd;
        const agents = extractPluginAgents(rawModule.agents ?? source.agents);
        if (agents) def.agents = agents;
        return def;
      }
    }
  }
  if (
    !source &&
    ("hooks" in rawModule ||
      "tools" in rawModule ||
      "mcpServers" in rawModule ||
      "agentsMd" in rawModule ||
      "agents" in rawModule ||
      "commands" in rawModule)
  ) {
    source = rawModule;
  }
  if (!source) return undefined;
  const hooks = isRecord(source.hooks) ? (source.hooks as Record<string, unknown>) : undefined;
  const tools = Array.isArray(source.tools) ? (source.tools as unknown[]) : undefined;
  const mcpServers = isRecord(source.mcpServers)
    ? Object.fromEntries(Object.entries(source.mcpServers).filter(([, v]) => isRecord(v)))
    : undefined;
  const def: PluginDefinition = { id };
  if (hooks) {
    const filtered: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(hooks)) {
      if (typeof v === "function") filtered[k] = v;
    }
    if (Object.keys(filtered).length > 0) def.hooks = filtered as PluginDefinition["hooks"];
  }
  if (tools) {
    const validTools: ToolSpec[] = [];
    for (const t of tools) {
      const check = validateToolSpec(t);
      if (check.valid) validTools.push(t as ToolSpec);
    }
    if (validTools.length > 0) def.tools = validTools;
  }
  if (mcpServers && Object.keys(mcpServers).length > 0) def.mcpServers = mcpServers;
  const agentsMd = extractAgentsMd(source.agentsMd);
  if (agentsMd) def.agentsMd = agentsMd;
  const agents = extractPluginAgents(source.agents);
  if (agents) def.agents = agents;
  const commands = extractPluginCommands(source.commands);
  if (commands) def.commands = commands;
  if (!def.hooks && !def.tools && !def.mcpServers && !def.agentsMd && !def.agents && !def.commands)
    return undefined;
  return def;
}

function discoverFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const entries = readdirSync(dir);
  const files: string[] = [];
  for (const e of entries) {
    const full = join(dir, e);
    try {
      const st = statSync(full);
      if (st.isFile() && /\.(m?js|cjs|ts|mts)$/.test(e)) files.push(full);
    } catch {
      /* best-effort: file may have been removed between readdir and stat */
    }
  }
  return files.sort();
}

async function loadModuleFile(
  filePath: string,
  logger?: Logger,
): Promise<Record<string, unknown> | undefined> {
  try {
    const url = pathToFileURL(resolve(filePath)).href;
    const mod = (await import(url)) as Record<string, unknown>;
    return mod;
  } catch (err) {
    logger?.error(`[plugins] failed to load ${filePath}:`, { error: String(err) });
    if (!logger) console.error(`[plugins] failed to load ${filePath}:`, err);
    return undefined;
  }
}

async function loadNpmPackage(spec: string, logger?: Logger): Promise<Record<string, unknown> | undefined> {
  try {
    const mod = (await import(spec)) as Record<string, unknown>;
    return mod;
  } catch (err) {
    logger?.error(`[plugins] failed to load npm plugin "${spec}":`, { error: String(err) });
    if (!logger) console.error(`[plugins] failed to load npm plugin "${spec}":`, err);
    return undefined;
  }
}

export async function loadPlugins(options: PluginLoaderOptions): Promise<PluginLoadResult> {
  const bus = options.bus;
  const logger = options.logger;
  const capabilities = options.capabilities ?? { tools: "*", pathScopes: "*", network: "none" };
  void options.identity;
  const registry = options.registry;

  const plugins: LoadedPlugin[] = [];
  const errors: Array<{ id: string; error: string }> = [];

  // In order: project .agency/plugins/, user config dir plugins, npm packages
  const projectDir = join(options.workspaceRoot, ".agency", "plugins");
  const userDir = join(options.configDirOverride ?? configDir(), "plugins");

  const projectFiles = discoverFiles(projectDir);
  const userFiles = discoverFiles(userDir);

  type Source = { id: string; path: string; kind: "file" | "npm"; tier: PluginTier };
  const sources: Source[] = [];
  for (const f of projectFiles)
    sources.push({
      id: basename(f).replace(/\.(m?js|cjs|ts|mts)$/, ""),
      path: f,
      kind: "file",
      tier: "project",
    });
  for (const f of userFiles)
    sources.push({
      id: basename(f).replace(/\.(m?js|cjs|ts|mts)$/, ""),
      path: f,
      kind: "file",
      tier: "user",
    });
  for (const spec of options.configPlugins ?? []) {
    // npm id is package name sanitized: @scope/name -> scope_name
    const id = spec.replace(/^@/, "").replace(/[^a-zA-Z0-9]/g, "_");
    sources.push({ id, path: spec, kind: "npm", tier: "npm" });
  }

  const maxInstructionBytes = options.maxInstructionBytes ?? DEFAULT_MAX_PLUGIN_INSTRUCTION_BYTES;
  // Tier-level AGENTS.md files first (project, then user), isolated per file.
  const instructions: string[] = collectPluginTierFiles(options.workspaceRoot, options.configDirOverride, {
    maxBytes: maxInstructionBytes,
  });

  const seen = new Set<string>();
  for (const src of sources) {
    if (seen.has(src.id)) {
      errors.push({ id: src.id, error: `duplicate plugin id "${src.id}" skipped (${src.path})` });
      continue;
    }
    seen.add(src.id);

    let mod: Record<string, unknown> | undefined;
    if (src.kind === "file") mod = await loadModuleFile(src.path, logger);
    else mod = await loadNpmPackage(src.path, logger);

    if (!mod) {
      errors.push({ id: src.id, error: `failed to load ${src.path}` });
      continue;
    }
    const def = extractDefinition(mod, src.id);
    if (!def) {
      errors.push({
        id: src.id,
        error: `invalid plugin shape at ${src.path}: must export hooks and/or tools and/or mcpServers and/or agentsMd and/or agents and/or commands`,
      });
      continue;
    }

    const unsubscribes: Array<() => void> = [];
    const ctx = createPluginHookContext(bus, capabilities, src.id, options.workspaceRoot);

    if (def.hooks) {
      for (const [hookName, handler] of Object.entries(def.hooks)) {
        const pattern = hookName === "event" ? "*" : hookName;
        const wrapped = wrapHookHandler(
          src.id,
          hookName,
          handler as (p: unknown, c: typeof ctx) => unknown,
          ctx,
        );
        const off = bus.on(pattern, wrapped);
        unsubscribes.push(off);
      }
    }

    if (def.tools && registry) {
      for (const tool of def.tools) {
        const namespaced = `${src.id}_${tool.name}`;
        if (registry.has(namespaced)) {
          logger?.error(`[plugins] tool "${namespaced}" already registered, skipping`);
          if (!logger) console.error(`[plugins] tool "${namespaced}" already registered, skipping`);
          continue;
        }
        try {
          const original = tool.handler;
          const wrappedTool: ToolSpec = {
            ...tool,
            name: namespaced,
            handler: async (input, tctx) => original(input as Record<string, unknown>, tctx),
          };
          (registry as unknown as { register(spec: ToolSpec): void }).register(wrappedTool);
        } catch (err) {
          logger?.error(`[plugins] failed to register tool "${namespaced}":`, { error: String(err) });
          if (!logger) console.error(`[plugins] failed to register tool "${namespaced}":`, err);
        }
      }
    }

    plugins.push({ id: src.id, path: src.path, tier: src.tier, definition: def, unsubscribes });

    if (src.kind === "file") {
      try {
        instructions.push(...readSiblingAgentsMd(src.path, { maxBytes: maxInstructionBytes }));
      } catch (err) {
        logger?.error(`[plugins] failed to collect instructions from plugin "${src.id}":`, {
          error: String(err),
        });
        if (!logger) console.error(`[plugins] failed to collect instructions from plugin "${src.id}":`, err);
      }
    }
    try {
      instructions.push(...collectPluginAgentsTexts(def, maxInstructionBytes, src.id));
    } catch (err) {
      logger?.error(`[plugins] failed to collect instructions from plugin "${src.id}":`, {
        error: String(err),
      });
      if (!logger) console.error(`[plugins] failed to collect instructions from plugin "${src.id}":`, err);
    }
  }

  // Skills: scan skills/ directories and convert to plugin entries.
  // Skills are Markdown files (not JS modules), so they bypass the module
  // loading pipeline and are converted directly to PluginDefinitions.
  const skillDirs = resolveSkillDirs(options.workspaceRoot, options.configDirOverride);
  const skills = discoverSkills(skillDirs, logger);
  for (const skill of skills) {
    if (seen.has(skill.name)) {
      errors.push({ id: skill.name, error: `duplicate skill id "${skill.name}" skipped (${skill.path})` });
      continue;
    }
    seen.add(skill.name);

    const def = skillToPlugin(skill);
    const unsubscribes: Array<() => void> = [];

    plugins.push({ id: skill.name, path: skill.path, tier: skill.tier, definition: def, unsubscribes });

    try {
      instructions.push(...collectPluginAgentsTexts(def, maxInstructionBytes, skill.name));
    } catch (err) {
      logger?.error(`[plugins] failed to collect instructions from skill "${skill.name}":`, {
        error: String(err),
      });
      if (!logger) console.error(`[plugins] failed to collect instructions from skill "${skill.name}":`, err);
    }
  }

  return { plugins, errors, instructions };
}

export function unloadPlugins(loaded: LoadedPlugin[]): void {
  for (const p of loaded) for (const off of p.unsubscribes) off();
}

/** Agent contributions across loaded plugins in load order. First handle wins. */
export function collectPluginAgents(
  plugins: LoadedPlugin[],
): Array<{ pluginId: string; agent: NonNullable<PluginDefinition["agents"]>[number] }> {
  const seen = new Set<string>();
  const out: Array<{ pluginId: string; agent: NonNullable<PluginDefinition["agents"]>[number] }> = [];
  for (const p of plugins) {
    for (const agent of p.definition.agents ?? []) {
      const handle = agent.handle ?? agent.role;
      if (seen.has(handle)) continue;
      seen.add(handle);
      out.push({ pluginId: p.id, agent });
    }
  }
  return out;
}

/** Command contributions across loaded plugins in load order. First name wins. */
export function collectPluginCommands(
  plugins: LoadedPlugin[],
): Array<{ pluginId: string; command: NonNullable<PluginDefinition["commands"]>[number] }> {
  const seen = new Set<string>();
  const out: Array<{ pluginId: string; command: NonNullable<PluginDefinition["commands"]>[number] }> = [];
  for (const p of plugins) {
    for (const command of p.definition.commands ?? []) {
      if (seen.has(command.name)) continue;
      seen.add(command.name);
      out.push({ pluginId: p.id, command });
    }
  }
  return out;
}

/** Raw per-skill MCP server declarations, or undefined when the skill declares none. */
export function pluginMcpServers(
  def: Pick<PluginDefinition, "mcpServers">,
): Record<string, unknown> | undefined {
  const raw = def.mcpServers;
  if (!raw || Object.keys(raw).length === 0) return undefined;
  return raw;
}
