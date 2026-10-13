import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

export const McpServerConfigSchema = z.object({
  command: z.string().optional(),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
  url: z.string().url().optional(),
  riskTier: z.enum(["safe", "moderate", "dangerous"]).optional(),
  headers: z.record(z.string(), z.string()).optional(),
  timeoutMs: z.number().int().positive().optional(),
  requestTimeoutMs: z.number().int().positive().optional(),
  toolCallTimeoutMs: z.number().int().positive().optional(),
  /** Read-only servers are safe to share across a team. */
  readOnly: z.boolean().optional(),
  /** Stateless servers hold no session state, so sharing never leaks. */
  stateless: z.boolean().optional(),
});

export type McpServerConfig = z.infer<typeof McpServerConfigSchema>;

export const McpServersConfigSchema = z.record(z.string(), McpServerConfigSchema);

export type McpServersConfig = z.infer<typeof McpServersConfigSchema>;

export function parseMcpServers(raw: unknown): McpServersConfig {
  return McpServersConfigSchema.parse(raw);
}

/** Puts the environment into each string: `${VAR}` and `${VAR:-default}`, as Claude Code does for `.mcp.json`. */
function expandEnv(value: unknown, env: Record<string, string | undefined>): unknown {
  if (typeof value === "string") {
    return value.replace(
      /\$\{(\w+)(?::-([^}]*))?\}/g,
      (_match, name: string, fallback?: string) => env[name] ?? fallback ?? "",
    );
  }
  if (Array.isArray(value)) return value.map((item) => expandEnv(item, env));
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, expandEnv(item, env)]));
  }
  return value;
}

/**
 * The MCP servers that a workspace brings: the files of `.agency/mcp` (`plugin install` writes one for each plugin),
 * then `.mcp.json`, the project file of Claude Code, which wins on a name. A file that is not valid is skipped.
 */
export function loadProjectMcpServers(
  workspaceRoot: string,
  warn: (message: string) => void = () => {},
  env: Record<string, string | undefined> = process.env,
): McpServersConfig {
  const dir = join(workspaceRoot, ".agency", "mcp");
  const files = existsSync(dir)
    ? readdirSync(dir)
        .filter((entry) => entry.endsWith(".json"))
        .sort()
        .map((entry) => join(dir, entry))
    : [];
  const servers: McpServersConfig = {};
  for (const file of [...files, join(workspaceRoot, ".mcp.json")]) {
    if (!existsSync(file)) continue;
    try {
      const raw = JSON.parse(readFileSync(file, "utf8")) as { mcpServers?: unknown };
      Object.assign(servers, parseMcpServers(expandEnv(raw.mcpServers ?? raw, env)));
    } catch (error) {
      warn(`MCP file ${file} is not valid: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return servers;
}
