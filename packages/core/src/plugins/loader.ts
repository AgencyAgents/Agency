import { existsSync, readdirSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { configDir } from "../paths.ts";
import { EventBus } from "../events.ts";
import type { Capabilities, CallerIdentity } from "@agency/guard";
import type { ToolSpec } from "../loop.ts";
import type { PluginDefinition, PluginHookContext, LoadedPlugin } from "./types.ts";

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
  registry?: PluginToolRegistry;
  capabilities?: Capabilities;
  identity?: CallerIdentity;
}

export interface PluginLoadResult {
  plugins: LoadedPlugin[];
  errors: Array<{ id: string; error: string }>;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function validateToolSpec(raw: unknown): { valid: boolean; reason?: string } {
  if (!isRecord(raw)) return { valid: false, reason: "tool must be an object" };
  if (typeof raw.name !== "string" || raw.name.length === 0) return { valid: false, reason: "tool.name must be non-empty string" };
  if (typeof raw.description !== "string") return { valid: false, reason: "tool.description must be string" };
  if (!isRecord(raw.inputSchema)) return { valid: false, reason: "tool.inputSchema must be object" };
  if (typeof raw.handler !== "function") return { valid: false, reason: "tool.handler must be function" };
  return { valid: true };
}

function extractDefinition(rawModule: Record<string, unknown>, id: string): PluginDefinition | undefined {
  // Supports: default export { hooks, tools }, named exports hooks/tools, or direct hooks object
  let source: Record<string, unknown> | undefined;
  if (isRecord(rawModule.default)) {
    source = rawModule.default as Record<string, unknown>;
    // If default itself looks like hooks map (no hooks/tools key but has known hook names or * ), treat it as hooks
    if (!("hooks" in source) && !("tools" in source)) {
      const keys = Object.keys(source);
      if (keys.some((k) => k.includes(".") || k === "event" || k === "*")) {
        return { id, hooks: source as Record<string, unknown> as PluginDefinition["hooks"] };
      }
    }
  }
  if (!source && ("hooks" in rawModule || "tools" in rawModule)) {
    source = rawModule;
  }
  if (!source) return undefined;
  const hooks = isRecord(source.hooks) ? (source.hooks as Record<string, unknown>) : undefined;
  const tools = Array.isArray(source.tools) ? (source.tools as unknown[]) : undefined;
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
  if (!def.hooks && !def.tools) return undefined;
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
    } catch {}
  }
  return files.sort();
}

async function loadModuleFile(filePath: string): Promise<Record<string, unknown> | undefined> {
  try {
    const url = pathToFileURL(resolve(filePath)).href;
    const mod = (await import(url)) as Record<string, unknown>;
    return mod;
  } catch (err) {
    console.error(`[plugins] failed to load ${filePath}:`, err);
    return undefined;
  }
}

async function loadNpmPackage(spec: string): Promise<Record<string, unknown> | undefined> {
  try {
    const mod = (await import(spec)) as Record<string, unknown>;
    return mod;
  } catch (err) {
    console.error(`[plugins] failed to load npm plugin "${spec}":`, err);
    return undefined;
  }
}

export async function loadPlugins(options: PluginLoaderOptions): Promise<PluginLoadResult> {
  const bus = options.bus;
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

  type Source = { id: string; path: string; kind: "file" | "npm" };
  const sources: Source[] = [];
  for (const f of projectFiles) sources.push({ id: basename(f).replace(/\.(m?js|cjs|ts|mts)$/, ""), path: f, kind: "file" });
  for (const f of userFiles) sources.push({ id: basename(f).replace(/\.(m?js|cjs|ts|mts)$/, ""), path: f, kind: "file" });
  for (const spec of options.configPlugins ?? []) {
    // npm id is package name sanitized: @scope/name -> scope_name
    const id = spec.replace(/^@/, "").replace(/[^a-zA-Z0-9]/g, "_");
    sources.push({ id, path: spec, kind: "npm" });
  }

  const seen = new Set<string>();
  for (const src of sources) {
    if (seen.has(src.id)) {
      errors.push({ id: src.id, error: `duplicate plugin id "${src.id}" skipped (${src.path})` });
      continue;
    }
    seen.add(src.id);

    let mod: Record<string, unknown> | undefined;
    if (src.kind === "file") mod = await loadModuleFile(src.path);
    else mod = await loadNpmPackage(src.path);

    if (!mod) {
      errors.push({ id: src.id, error: `failed to load ${src.path}` });
      continue;
    }
    const def = extractDefinition(mod, src.id);
    if (!def) {
      errors.push({ id: src.id, error: `invalid plugin shape at ${src.path}: must export hooks and/or tools` });
      continue;
    }

    const unsubscribes: Array<() => void> = [];
    const ctx: PluginHookContext = { bus, capabilities, identity: { type: "plugin", id: src.id }, workspaceRoot: options.workspaceRoot };

    if (def.hooks) {
      for (const [hookName, handler] of Object.entries(def.hooks)) {
        const pattern = hookName === "event" ? "*" : hookName;
        const wrapped = async (payload: unknown) => {
          try {
            await (handler as (p: unknown, c: PluginHookContext) => unknown)(payload, ctx);
          } catch (err) {
            console.error(`[plugins] hook "${hookName}" in plugin "${src.id}" threw:`, err);
          }
        };
        const off = bus.on(pattern, wrapped);
        unsubscribes.push(off);
      }
    }

    if (def.tools && registry) {
      for (const tool of def.tools) {
        const namespaced = `${src.id}_${tool.name}`;
        if (registry.has(namespaced)) {
          console.error(`[plugins] tool "${namespaced}" already registered, skipping`);
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
          console.error(`[plugins] failed to register tool "${namespaced}":`, err);
        }
      }
    }

    plugins.push({ id: src.id, path: src.path, definition: def, unsubscribes });
  }

  return { plugins, errors };
}

export function unloadPlugins(loaded: LoadedPlugin[]): void {
  for (const p of loaded) for (const off of p.unsubscribes) off();
}
