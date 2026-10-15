import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { configDir, dataDir, loadConfig } from "@agency/core";
import { createFileTrustStore } from "@agency/guard";
import { type MessageKey, t } from "@agency/i18n";
import { createKeychain, type KeychainBackend, openInBrowser } from "@agency/providers";
import {
  importMcpServers,
  keychainTokenStore,
  loadProjectMcpServers,
  loadUserMcpServers,
  MCP_IMPORT_SOURCES,
  type McpImportSource,
  type McpServerConfig,
  McpServerConfigSchema,
  signInMcpServer,
} from "@agency/tools";

/** `agency mcp import <client>`: the MCP servers of the user file of another client go to `mcp/<client>.json`. */
function importCmd(options: {
  source: string | undefined;
  configDir: string;
  env: NodeJS.ProcessEnv;
  out: (line: string) => void;
  err: (line: string) => void;
}): number {
  const { env, out, err } = options;
  const where = { home: env.USERPROFILE ?? env.HOME ?? homedir(), env, platform: process.platform };
  const source = options.source as McpImportSource;
  if (!MCP_IMPORT_SOURCES.includes(source)) {
    const found = MCP_IMPORT_SOURCES.map((s) =>
      importMcpServers(s, where) === undefined ? s : `${s} (found)`,
    );
    err(t("cli.mcp.import_usage", { sources: found.join(", ") }));
    return 1;
  }
  let imported: ReturnType<typeof importMcpServers>;
  try {
    imported = importMcpServers(source, where, err);
  } catch (error) {
    err(
      t("cli.mcp.import_failed", { source, reason: error instanceof Error ? error.message : String(error) }),
    );
    return 1;
  }
  if (imported === undefined) {
    err(t("cli.mcp.import_none", { source }));
    return 1;
  }
  const names = Object.keys(imported.servers);
  if (names.length === 0) {
    out(t("cli.mcp.import_empty", { source, file: imported.file }));
    return 0;
  }
  // The file can hold keys of the servers: only the user can read it.
  const dir = join(options.configDir, "mcp");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  const text = `${JSON.stringify({ mcpServers: imported.servers }, null, 2)}\n`;
  writeFileSync(join(dir, `${source}.json`), text, { mode: 0o600 });
  out(t("cli.mcp.imported", { source, file: imported.file, names: names.join(", ") }));
  return 0;
}

const SERVER_NAME = /^[A-Za-z0-9_-]{1,64}$/;

/** The options of `agency mcp`, beside the action and the server name. */
interface McpCmdOptions {
  workspaceRoot: string;
  configDir: string;
  env: NodeJS.ProcessEnv;
  /** The words after the server name: the command or url of `add`, the JSON of `add-json`. */
  rest: string[];
  serverEnv: string[];
  headers: string[];
  transport: string | undefined;
  scope: string | undefined;
  overwrite: boolean;
  json: boolean;
  out: (line: string) => void;
  err: (line: string) => void;
}

/** The servers that the daemon of the workspace starts, each with its origin; a later origin wins on a name. */
function knownServers(o: Pick<McpCmdOptions, "workspaceRoot" | "configDir" | "env">) {
  const config = loadConfig({ globalDir: o.configDir, env: o.env });
  const trusted = createFileTrustStore(join(dataDir(o.env), "trust.json")).isTrusted(o.workspaceRoot);
  const rows = new Map<string, { origin: string; started: boolean; server: McpServerConfig }>();
  const add = (origin: string, started: boolean, servers: Record<string, unknown> | undefined) => {
    for (const [name, server] of Object.entries(servers ?? {}))
      rows.set(name, { origin, started, server: server as McpServerConfig });
  };
  add("project", trusted, loadProjectMcpServers(o.workspaceRoot));
  add("user", true, loadUserMcpServers(o.configDir));
  add("config", true, config.mcpServers);
  return { rows, trusted };
}

/** The file that `add` writes: `mcp/added.json` of the user config, or the `.mcp.json` of the workspace. */
const addedFile = (o: Pick<McpCmdOptions, "workspaceRoot" | "configDir">, scope: string | undefined) =>
  scope === "project" ? join(o.workspaceRoot, ".mcp.json") : join(o.configDir, "mcp", "added.json");

function readServerFile(file: string): { raw: Record<string, unknown>; servers: Record<string, unknown> } {
  const raw = existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>) : {};
  return { raw, servers: { ...(raw.mcpServers as Record<string, unknown> | undefined) } };
}

function writeServerFile(file: string, raw: Record<string, unknown>, servers: Record<string, unknown>): void {
  mkdirSync(dirname(file), { recursive: true });
  // The user file can hold keys of the servers: only the user can read it.
  writeFileSync(file, `${JSON.stringify({ ...raw, mcpServers: servers }, null, 2)}\n`, { mode: 0o600 });
}

/** `KEY=value` of `--env` or `Name: value` of `--header` as a record. */
function pairs(list: string[], separator: string, message: MessageKey): Record<string, string> {
  const out: Record<string, string> = {};
  for (const item of list) {
    const at = item.indexOf(separator);
    if (at <= 0) throw new Error(t(message, { value: item }));
    out[item.slice(0, at).trim()] = item.slice(at + 1).trim();
  }
  return out;
}

/** The server of `add`: a url with `--transport http` (or a lone url), else a command and its arguments. */
function flagServer(o: McpCmdOptions): Record<string, unknown> {
  const [target, ...args] = o.rest;
  const transport =
    o.transport ?? (args.length === 0 && /^https?:\/\//i.test(target ?? "") ? "http" : "stdio");
  if (transport !== "http" && transport !== "sse" && transport !== "stdio")
    throw new Error(t("cli.mcp.transport", { transport }));
  if (target === undefined || (transport !== "stdio" && args.length > 0))
    throw new Error(t("cli.mcp.add_usage"));
  if (transport === "stdio") {
    const env = pairs(o.serverEnv, "=", "cli.mcp.bad_env");
    return { type: "stdio", command: target, args, ...(Object.keys(env).length > 0 ? { env } : {}) };
  }
  if (!URL.canParse(target)) throw new Error(t("cli.mcp.bad_url", { url: target }));
  const headers = pairs(o.headers, ":", "cli.mcp.bad_header");
  return { type: transport, url: target, ...(Object.keys(headers).length > 0 ? { headers } : {}) };
}

/** The server of `add-json`: the entry of an `mcpServers` map, as Claude Code writes it. */
function jsonServer(rest: string[]): Record<string, unknown> {
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(rest.join(" ")) as Record<string, unknown>;
  } catch (error) {
    throw new Error(
      t("cli.mcp.bad_json", { reason: error instanceof Error ? error.message : String(error) }),
    );
  }
  const parsed = McpServerConfigSchema.safeParse(raw);
  if (!parsed.success)
    throw new Error(
      t("cli.mcp.bad_json", {
        reason: parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; "),
      }),
    );
  if (raw.command === undefined && raw.url === undefined)
    throw new Error(t("cli.mcp.bad_json", { reason: "it needs a command or a url" }));
  return raw;
}

function addCmd(name: string | undefined, json: boolean, o: McpCmdOptions): number {
  if (name === undefined || !SERVER_NAME.test(name)) {
    o.err(t("cli.mcp.add_usage"));
    return 1;
  }
  const file = addedFile(o, o.scope);
  try {
    const server = json ? jsonServer(o.rest) : flagServer(o);
    const { raw, servers } = readServerFile(file);
    if (servers[name] !== undefined && !o.overwrite) {
      o.err(t("cli.mcp.exists", { name, file }));
      return 1;
    }
    writeServerFile(file, raw, { ...servers, [name]: server });
  } catch (error) {
    o.err(error instanceof Error ? error.message : String(error));
    return 1;
  }
  o.out(t("cli.mcp.added", { name, file }));
  if (o.scope === "project" && !knownServers(o).trusted) o.out(t("cli.mcp.untrusted"));
  return 0;
}

/** A server as `list` and `get` print it: the values of its env and headers are hidden. */
function shown(server: McpServerConfig): McpServerConfig {
  const hide = (map: Record<string, string> | undefined) =>
    map && Object.fromEntries(Object.keys(map).map((key) => [key, "***"]));
  return {
    ...server,
    ...(server.env ? { env: hide(server.env) } : {}),
    ...(server.headers ? { headers: hide(server.headers) } : {}),
  };
}

function listCmd(o: McpCmdOptions): number {
  const { rows } = knownServers(o);
  if (o.json) {
    const entries = [...rows].map(([name, row]) => [name, { ...row, server: shown(row.server) }]);
    o.out(JSON.stringify(Object.fromEntries(entries)));
    return 0;
  }
  if (rows.size === 0) o.out(t("cli.mcp.none"));
  for (const [name, { origin, started, server }] of rows) {
    const target = server.url ?? [server.command, ...(server.args ?? [])].join(" ");
    o.out(`${name} (${started ? origin : t("cli.mcp.not_started", { origin })}): ${target}`);
  }
  return 0;
}

function getCmd(name: string | undefined, o: McpCmdOptions): number {
  const { rows } = knownServers(o);
  const row = name === undefined ? undefined : rows.get(name);
  if (name === undefined || row === undefined) {
    o.err(t("cli.mcp.unknown", { name: name ?? "", names: [...rows.keys()].join(", ") || "-" }));
    return 1;
  }
  o.out(JSON.stringify({ name, ...row, server: shown(row.server) }, null, 2));
  return 0;
}

function removeCmd(name: string | undefined, o: McpCmdOptions): number {
  if (name === undefined) {
    o.err(t("cli.mcp.usage"));
    return 1;
  }
  for (const scope of o.scope === undefined ? ["user", "project"] : [o.scope]) {
    const file = addedFile(o, scope);
    const { raw, servers } = readServerFile(file);
    if (servers[name] === undefined) continue;
    delete servers[name];
    writeServerFile(file, raw, servers);
    o.out(t("cli.mcp.removed", { name, file }));
    return 0;
  }
  const row = knownServers(o).rows.get(name);
  o.err(
    row ? t("cli.mcp.not_added", { name, origin: row.origin }) : t("cli.mcp.unknown", { name, names: "-" }),
  );
  return 1;
}

/** `agency mcp add|add-json|list|get|remove|login|logout|import`. */
export async function mcpCmd(
  options: Omit<McpCmdOptions, "configDir"> & {
    action: string | undefined;
    name: string | undefined;
    configDir?: string;
    keychain?: KeychainBackend;
    openUrl?: (url: string) => Promise<void> | void;
  },
): Promise<number> {
  const { action, name, out, err } = options;
  const userDir = options.configDir ?? configDir(options.env);
  const o = { ...options, configDir: userDir };
  if (o.scope !== undefined && o.scope !== "user" && o.scope !== "project") {
    err(t("cli.mcp.scope", { scope: o.scope }));
    return 1;
  }
  switch (action) {
    case "import":
      return importCmd({ source: name, configDir: userDir, env: options.env, out, err });
    case "add":
    case "add-json":
      return addCmd(name, action === "add-json", o);
    case "list":
      return listCmd(o);
    case "get":
      return getCmd(name, o);
    case "remove":
      return removeCmd(name, o);
  }
  if ((action !== "login" && action !== "logout") || !name) {
    err(t("cli.mcp.usage"));
    return 1;
  }
  // The servers of the daemon: a server of an untrusted workspace does not start.
  const { rows } = knownServers(o);
  const started = [...rows].filter(([, row]) => row.started);
  const server = started.find(([key]) => key === name)?.[1].server;
  const url = server?.url;
  if (server === undefined) {
    err(t("cli.mcp.unknown", { name, names: started.map(([key]) => key).join(", ") || "-" }));
    return 1;
  }
  if (url === undefined) {
    err(t("cli.mcp.local", { name }));
    return 1;
  }
  const keychain =
    options.keychain ?? (await createKeychain(process.platform, join(dataDir(options.env), "keys")));
  const store = keychainTokenStore(async () => keychain);
  if (action === "logout") {
    await store.delete(url);
    out(t("cli.mcp.signed_out", { name }));
    return 0;
  }
  try {
    await signInMcpServer(url, store, {
      openUrl:
        options.openUrl ??
        (async (authorizeUrl) => {
          out(t("cli.mcp.opening", { name, url: authorizeUrl }));
          await openInBrowser(authorizeUrl);
        }),
    });
  } catch (error) {
    err(t("cli.mcp.failed", { name, reason: error instanceof Error ? error.message : String(error) }));
    return 1;
  }
  out(t("cli.mcp.signed_in", { name }));
  return 0;
}

/** One call of the `agency` tool of `agency mcp serve`. */
export interface McpTurnCall {
  prompt: string;
  session: string;
  cwd?: string;
  model?: string;
}

const MCP_PROTOCOL_VERSIONS = ["2024-11-05", "2025-03-26", "2025-06-18", "2025-11-25"];

const AGENCY_TOOL = {
  name: "agency",
  description:
    "Runs the Agency coding agent on a task in a workspace and returns its answer. To continue the conversation of an earlier call, pass its session.",
  inputSchema: {
    type: "object",
    properties: {
      prompt: { type: "string", description: "The task or the question." },
      cwd: { type: "string", description: "The workspace folder. Default: the folder of the server." },
      session: { type: "string", description: "The session of an earlier call, to continue it." },
      model: { type: "string", description: "provider/model. Default: the model of the config." },
    },
    required: ["prompt"],
  },
  outputSchema: {
    type: "object",
    properties: { text: { type: "string" }, session: { type: "string" } },
    required: ["text", "session"],
  },
};

class RpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

/** `agency mcp serve`: Agency as an MCP server on stdio, with one tool that runs a turn, as `codex mcp-server` does. */
export async function mcpServe(options: {
  version: string;
  input: AsyncIterable<string>;
  out: (line: string) => void;
  turn: (call: McpTurnCall) => Promise<{ text: string; isError: boolean }>;
}): Promise<number> {
  const send = (message: object) => options.out(JSON.stringify({ jsonrpc: "2.0", ...message }));
  const answer = async (method: unknown, params: Record<string, unknown>): Promise<object> => {
    switch (method) {
      case "initialize": {
        const asked = params.protocolVersion;
        return {
          protocolVersion: MCP_PROTOCOL_VERSIONS.includes(asked as string)
            ? asked
            : MCP_PROTOCOL_VERSIONS.at(-1),
          capabilities: { tools: {} },
          serverInfo: { name: "agency", version: options.version },
        };
      }
      case "ping":
        return {};
      case "tools/list":
        return { tools: [AGENCY_TOOL] };
      case "tools/call": {
        const args = (params.arguments ?? {}) as Record<string, unknown>;
        if (params.name !== AGENCY_TOOL.name)
          throw new RpcError(-32602, `unknown tool: ${String(params.name)}`);
        if (typeof args.prompt !== "string" || args.prompt.trim() === "") {
          throw new RpcError(-32602, "prompt must be a non-empty string");
        }
        // The session names a file: a caller must not reach outside the sessions folder.
        if (args.session !== undefined && !/^[\w-]{1,128}$/.test(String(args.session))) {
          throw new RpcError(-32602, "session must be 1-128 letters, digits, _ or -");
        }
        for (const key of ["cwd", "model"]) {
          if (args[key] !== undefined && typeof args[key] !== "string") {
            throw new RpcError(-32602, `${key} must be a string`);
          }
        }
        const session = (args.session as string | undefined) ?? `mcp-${randomUUID()}`;
        const { text, isError } = await options.turn({
          prompt: args.prompt,
          session,
          ...(args.cwd === undefined ? {} : { cwd: args.cwd as string }),
          ...(args.model === undefined ? {} : { model: args.model as string }),
        });
        return {
          content: [
            { type: "text", text },
            { type: "text", text: `session: ${session}` },
          ],
          structuredContent: { text, session },
          isError,
        };
      }
      default:
        throw new RpcError(-32601, `method not found: ${String(method)}`);
    }
  };

  // ponytail: no notifications/cancelled; a call runs to its end. Add when a client cancels long turns.
  const pending = new Set<Promise<void>>();
  for await (const line of options.input) {
    if (line.trim() === "") continue;
    let request: { id?: string | number | null; method?: unknown; params?: unknown };
    try {
      request = JSON.parse(line);
    } catch {
      send({ id: null, error: { code: -32700, message: "parse error" } });
      continue;
    }
    const { id } = request;
    if (id === undefined || id === null) continue;
    const params = (
      typeof request.params === "object" && request.params !== null ? request.params : {}
    ) as Record<string, unknown>;
    const job = answer(request.method, params).then(
      (result) => send({ id, result }),
      (error: unknown) =>
        send({
          id,
          error: {
            code: error instanceof RpcError ? error.code : -32603,
            message: error instanceof Error ? error.message : String(error),
          },
        }),
    );
    pending.add(job);
    void job.finally(() => pending.delete(job));
  }
  await Promise.all(pending);
  return 0;
}
