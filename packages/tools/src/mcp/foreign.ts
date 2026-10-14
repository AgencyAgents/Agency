import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parse as parseJsonc } from "jsonc-parser";

type Raw = Record<string, unknown>;

/** Where the user files of the other clients are. Tests give their own. */
export interface ClientHome {
  home: string;
  env: Record<string, string | undefined>;
  platform: NodeJS.Platform;
}

interface McpClient {
  /** Files in the workspace, relative to its root. */
  project: string[];
  /** Files of the user, the first that exists counts. */
  user: (where: ClientHome) => string[];
  /** The key of the server map in the file. */
  key: string;
  /** One server in the form of `mcpServers`, or undefined when it is off. */
  normalize: (server: Raw) => Raw | undefined;
}

const record = (value: unknown): Raw =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Raw) : {};

/** Drops the keys with no value: the schema of a server has no place for them. */
function defined(server: Raw): Raw {
  return Object.fromEntries(Object.entries(server).filter(([, value]) => value !== undefined));
}

const off = (server: Raw): boolean => server.enabled === false || server.disabled === true;

const base = (server: Raw): Raw | undefined =>
  off(server)
    ? undefined
    : defined({
        command: server.command,
        args: server.args,
        env: server.env,
        url: server.url ?? server.serverUrl,
        headers: server.headers,
      });

const gemini = (server: Raw): Raw | undefined => {
  const out = base({ ...server, url: server.httpUrl ?? server.url });
  if (out === undefined) return undefined;
  // Gemini expands `$VAR` in env values only.
  const env = record(server.env);
  if (Object.keys(env).length > 0) {
    out.env = Object.fromEntries(
      Object.entries(env).map(([key, value]) => [
        key,
        String(value).replace(/\$(\w+)/g, (_m, name: string) => `\${${name}}`),
      ]),
    );
  }
  return defined({ ...out, requestTimeoutMs: server.timeout });
};

const opencode = (server: Raw): Raw | undefined => {
  if (off(server)) return undefined;
  if (server.type === "remote") return defined({ url: server.url, headers: server.headers });
  const [command, ...args] = Array.isArray(server.command) ? server.command.map(String) : [];
  return defined({ command, args: args.length > 0 ? args : undefined, env: server.environment });
};

const codex = (server: Raw): Raw | undefined => {
  if (off(server)) return undefined;
  const headers: Record<string, string> = { ...(record(server.http_headers) as Record<string, string>) };
  for (const [name, variable] of Object.entries(record(server.env_http_headers)))
    headers[name] = `\${${variable}}`;
  if (typeof server.bearer_token_env_var === "string") {
    headers.Authorization = `Bearer \${${server.bearer_token_env_var}}`;
  }
  const seconds = typeof server.tool_timeout_sec === "number" ? server.tool_timeout_sec : undefined;
  return defined({
    ...base(server),
    headers: Object.keys(headers).length > 0 ? headers : undefined,
    toolCallTimeoutMs: seconds === undefined ? undefined : seconds * 1000,
  });
};

const zed = (server: Raw): Raw | undefined => {
  const command = record(server.command);
  if (typeof server.command === "string" || Object.keys(command).length === 0) return base(server);
  return base({ ...server, command: command.path, args: command.args, env: command.env });
};

const appData = (where: ClientHome): string => where.env.APPDATA ?? join(where.home, "AppData", "Roaming");
/** The settings folder of a desktop app: `%APPDATA%`, `~/Library/Application Support` or `~/.config`. */
function appConfig(where: ClientHome, ...parts: string[]): string {
  if (where.platform === "win32") return join(appData(where), ...parts);
  if (where.platform === "darwin") return join(where.home, "Library", "Application Support", ...parts);
  return join(where.env.XDG_CONFIG_HOME ?? join(where.home, ".config"), ...parts);
}
const xdg = (where: ClientHome, ...parts: string[]): string =>
  join(where.env.XDG_CONFIG_HOME ?? join(where.home, ".config"), ...parts);

const CLIENTS = {
  vscode: {
    project: [".vscode/mcp.json"],
    user: (w) => [appConfig(w, "Code", "User", "mcp.json")],
    key: "servers",
    normalize: base,
  },
  cursor: {
    project: [".cursor/mcp.json"],
    user: (w) => [join(w.home, ".cursor", "mcp.json")],
    key: "mcpServers",
    normalize: base,
  },
  gemini: {
    project: [".gemini/settings.json"],
    user: (w) => [join(w.home, ".gemini", "settings.json")],
    key: "mcpServers",
    normalize: gemini,
  },
  opencode: {
    project: ["opencode.json", "opencode.jsonc"],
    user: (w) => [xdg(w, "opencode", "opencode.json"), xdg(w, "opencode", "opencode.jsonc")],
    key: "mcp",
    normalize: opencode,
  },
  codex: {
    project: [".codex/config.toml"],
    user: (w) => [join(w.env.CODEX_HOME ?? join(w.home, ".codex"), "config.toml")],
    key: "mcp_servers",
    normalize: codex,
  },
  pi: {
    project: [".pi/mcp.json"],
    user: (w) => [join(w.env.PI_CODING_AGENT_DIR ?? join(w.home, ".pi", "agent"), "mcp.json")],
    key: "mcpServers",
    normalize: base,
  },
  claude: { project: [], user: (w) => [join(w.home, ".claude.json")], key: "mcpServers", normalize: base },
  "claude-desktop": {
    project: [],
    user: (w) => [appConfig(w, "Claude", "claude_desktop_config.json")],
    key: "mcpServers",
    normalize: base,
  },
  windsurf: {
    project: [],
    user: (w) => [
      join(w.home, ".codeium", "windsurf", "mcp_config.json"),
      w.platform === "win32"
        ? join(appData(w), "devin", "mcp_config.json")
        : xdg(w, "devin", "mcp_config.json"),
    ],
    key: "mcpServers",
    normalize: base,
  },
  zed: {
    project: [".zed/settings.json"],
    user: (w) => [
      w.platform === "win32" ? join(appData(w), "Zed", "settings.json") : xdg(w, "zed", "settings.json"),
    ],
    key: "context_servers",
    normalize: zed,
  },
} satisfies Record<string, McpClient>;

export type McpImportSource = keyof typeof CLIENTS;
export const MCP_IMPORT_SOURCES = Object.keys(CLIENTS) as McpImportSource[];

/** The variables of the other clients in the `${VAR}` form of `.mcp.json`. */
function toClaudeVariables(value: unknown): unknown {
  if (typeof value === "string") {
    return value
      .replace(/\$\{env:(\w+)\}/g, (_m, name: string) => `\${${name}}`)
      .replace(/(?<!\$)\{env:(\w+)\}/g, (_m, name: string) => `\${${name}}`)
      .replaceAll("${/}", "/")
      .replaceAll("${workspacePath}", "${workspaceFolder}");
  }
  if (Array.isArray(value)) return value.map(toClaudeVariables);
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, toClaudeVariables(item)]));
  }
  return value;
}

/** The servers of one file of a client, in the form of `mcpServers`. A file that does not parse throws. */
function readClientFile(
  file: string,
  client: McpClient,
  warn: (message: string) => void,
): Record<string, Raw> {
  const text = readFileSync(file, "utf8");
  let raw: unknown;
  if (file.endsWith(".toml")) raw = Bun.TOML.parse(text);
  else {
    const errors: unknown[] = [];
    raw = parseJsonc(text, errors as never, { allowTrailingComma: true });
    if (errors.length > 0) throw new Error("the file is not valid JSON");
  }
  const servers = normalizeServers(client, record(raw)[client.key]);
  for (const [name, server] of Object.entries(servers)) {
    // VS Code asks the user for an input; Agency has no such question.
    if (JSON.stringify(server).includes("${input:")) {
      warn(`MCP server "${name}" of ${file} needs an input that its client asks for: it is skipped`);
      delete servers[name];
    }
  }
  return servers;
}

function normalizeServers(client: McpClient, servers: unknown): Record<string, Raw> {
  const out: Record<string, Raw> = {};
  for (const [name, entry] of Object.entries(record(servers))) {
    const server = client.normalize(record(entry));
    if (server !== undefined) out[name] = toClaudeVariables(server) as Raw;
  }
  return out;
}

/** A server map in the format of a client (a Gemini extension, a Cursor plugin), in the form of `mcpServers`. */
export function normalizeMcpServers(source: McpImportSource, servers: unknown): Record<string, Raw> {
  return normalizeServers(CLIENTS[source], servers);
}

const projectFiles = (workspaceRoot: string) =>
  Object.values(CLIENTS as Record<string, McpClient>).flatMap((client) =>
    client.project.map((path) => ({ file: join(workspaceRoot, path), client })),
  );

/** Each MCP file of another client that a workspace can have, for the daemon to see a change. */
export function clientProjectPaths(workspaceRoot: string): string[] {
  return projectFiles(workspaceRoot).map(({ file }) => file);
}

/** The MCP files of other clients in a workspace, lowest precedence first, with a reader for each. */
export function clientProjectFiles(
  workspaceRoot: string,
): Array<{ file: string; read: (warn: (message: string) => void) => Record<string, Raw> }> {
  return projectFiles(workspaceRoot)
    .filter(({ file }) => existsSync(file))
    .map(({ file, client }) => ({
      file,
      read: (warn: (message: string) => void) => readClientFile(file, client, warn),
    }));
}

/** The MCP servers of the user file of a client, with its variables kept. Undefined when the client has no file. */
export function importMcpServers(
  source: McpImportSource,
  where: ClientHome = { home: homedir(), env: process.env, platform: process.platform },
  warn: (message: string) => void = () => {},
): { file: string; servers: Record<string, Raw> } | undefined {
  const client: McpClient = CLIENTS[source];
  const file = client.user(where).find((path) => existsSync(path));
  return file === undefined ? undefined : { file, servers: readClientFile(file, client, warn) };
}
