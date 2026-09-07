import type { Capabilities } from "@agency/guard";
import type { ProcessManager } from "../process-manager.ts";
import type { ToolRegistry } from "../registry.ts";
import { type McpServersConfig, parseMcpServers } from "./config.ts";
import { type McpManager, type McpManagerOptions, startMcpServers } from "./manager.ts";

/**
 * Structural shape of a skill (plugin) declaring embedded MCP servers.
 * Matches `PluginDefinition` (`id` + `mcpServers`) without depending on
 * `@agency/core`, so the tools package stays dependency-free.
 */
export interface SkillMcpSource {
  id: string;
  mcpServers?: Record<string, unknown>;
}

export interface SkillMcpOptions {
  capabilities: Capabilities;
  processManager?: ProcessManager;
  transportFor?: McpManagerOptions["transportFor"];
  identityFor?: McpManagerOptions["identityFor"];
  /**
   * Optional registry for the scoped tools. Omit it (default) and the skill's
   * tools live only on the returned manager — the session's main registry is
   * never touched, so there is no context bloat. Pass one only when the task
   * explicitly wants the skill's tools callable by name during the task; they
   * are unregistered again on dispose.
   */
  registry?: ToolRegistry;
}

/**
 * Spawn a skill's declared `mcpServers` on demand. Returns undefined when the
 * skill declares none (no processes started). Throws a legible error when the
 * declaration is invalid. The caller owns the result and must dispose it —
 * prefer `withSkillMcp`, which guarantees cleanup when the task is done.
 */
export async function startSkillMcpServers(
  source: SkillMcpSource,
  options: SkillMcpOptions,
): Promise<McpManager | undefined> {
  const raw = source.mcpServers;
  if (!raw || Object.keys(raw).length === 0) return undefined;
  let servers: McpServersConfig;
  try {
    servers = parseMcpServers(raw);
  } catch (error) {
    throw new Error(`invalid mcpServers for skill "${source.id}": ${String(error)}`);
  }
  const registry = options.registry;
  const manager = await startMcpServers({
    servers,
    capabilities: options.capabilities,
    processManager: options.processManager,
    transportFor: options.transportFor,
    registry,
    identityFor: options.identityFor,
  });
  let disposed = false;
  const innerDispose = manager.dispose.bind(manager);
  const scoped: McpManager = {
    tools: manager.tools,
    failures: manager.failures,
    identityFor: manager.identityFor,
    async dispose() {
      if (disposed) return;
      disposed = true;
      const names = manager.tools.map((t) => t.name);
      try {
        await innerDispose();
      } finally {
        if (registry) {
          for (const name of names) {
            try {
              registry.unregister(name);
            } catch {
              // already removed (e.g. crash path) — scoped cleanup is best-effort
            }
          }
        }
      }
    },
  };
  return scoped;
}

/**
 * Run `fn` with the skill's MCP servers spawned, then dispose them — even
 * when `fn` throws. `fn` receives undefined when the skill declares no
 * servers. No processes, transports, or registry entries survive the task.
 */
export async function withSkillMcp<T>(
  source: SkillMcpSource,
  options: SkillMcpOptions,
  fn: (manager: McpManager | undefined) => Promise<T>,
): Promise<T> {
  const manager = await startSkillMcpServers(source, options);
  try {
    return await fn(manager);
  } finally {
    await manager?.dispose();
  }
}
