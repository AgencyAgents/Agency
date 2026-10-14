import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { z } from "zod";
import { clientProjectFiles } from "./foreign.ts";

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

type ServerSource = { file: string; read: (warn: (message: string) => void) => unknown };

const jsonFiles = (dir: string): ServerSource[] =>
  existsSync(dir)
    ? readdirSync(dir)
        .filter((entry) => entry.endsWith(".json"))
        .sort()
        .map((entry) => join(dir, entry))
        .map((file) => ({ file, read: () => readServerMap(file) }))
    : [];

function readServerMap(file: string): unknown {
  const raw = JSON.parse(readFileSync(file, "utf8")) as { mcpServers?: unknown };
  return raw.mcpServers ?? raw;
}

/** Merges the sources in order, a later one winning on a name. A file that is not valid is skipped. */
function mergeSources(
  sources: ServerSource[],
  vars: Record<string, string | undefined>,
  warn: (message: string) => void,
): McpServersConfig {
  const servers: McpServersConfig = {};
  for (const { file, read } of sources) {
    try {
      Object.assign(servers, parseMcpServers(expandEnv(read(warn), vars)));
    } catch (error) {
      warn(`MCP file ${file} is not valid: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return servers;
}

/** `${workspaceFolder}` and `${userHome}` of VS Code and Cursor, beside the environment. */
function pathVars(workspaceRoot: string | undefined): Record<string, string> {
  return {
    userHome: homedir(),
    ...(workspaceRoot === undefined
      ? {}
      : { workspaceFolder: workspaceRoot, workspaceFolderBasename: basename(workspaceRoot) }),
  };
}

/**
 * The MCP servers that a workspace brings: the files of `.agency/mcp` (`plugin install` writes one for each plugin),
 * the project files of other clients (VS Code, Cursor, Gemini, OpenCode, Codex, Pi, Zed), then `.mcp.json`, the
 * project file of Claude Code, which wins on a name.
 */
export function loadProjectMcpServers(
  workspaceRoot: string,
  warn: (message: string) => void = () => {},
  env: Record<string, string | undefined> = process.env,
): McpServersConfig {
  const claude = join(workspaceRoot, ".mcp.json");
  return mergeSources(
    [
      ...jsonFiles(join(workspaceRoot, ".agency", "mcp")),
      ...clientProjectFiles(workspaceRoot),
      ...(existsSync(claude) ? [{ file: claude, read: () => readServerMap(claude) }] : []),
    ],
    { ...pathVars(workspaceRoot), ...env },
    warn,
  );
}

/**
 * The servers of a `--mcp-config` value, as Claude Code takes it: a JSON file or JSON text, with or without the
 * `mcpServers` key. `${VAR}` takes the environment of the caller, not that of the daemon.
 */
export function loadMcpConfigArg(
  value: string,
  cwd: string,
  env: Record<string, string | undefined> = process.env,
): McpServersConfig {
  const text = value.trimStart().startsWith("{") ? value : readFileSync(resolve(cwd, value), "utf8");
  const raw = JSON.parse(text) as { mcpServers?: unknown };
  return parseMcpServers(expandEnv(raw.mcpServers ?? raw, { ...pathVars(cwd), ...env }));
}

/** The servers that `agency mcp import` wrote to `mcp/` of the user config directory. */
export function loadUserMcpServers(
  configDir: string,
  warn: (message: string) => void = () => {},
  env: Record<string, string | undefined> = process.env,
  workspaceRoot?: string,
): McpServersConfig {
  return mergeSources(jsonFiles(join(configDir, "mcp")), { ...pathVars(workspaceRoot), ...env }, warn);
}
