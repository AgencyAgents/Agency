import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { configDir, dataDir, loadConfig } from "@agency/core";
import { createFileTrustStore } from "@agency/guard";
import { t } from "@agency/i18n";
import { createKeychain, type KeychainBackend, openInBrowser } from "@agency/providers";
import {
  importMcpServers,
  keychainTokenStore,
  loadProjectMcpServers,
  loadUserMcpServers,
  MCP_IMPORT_SOURCES,
  type McpImportSource,
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

/** `agency mcp login|logout <server>`: the sign-in of an MCP server over HTTP. */
export async function mcpCmd(options: {
  action: string | undefined;
  name: string | undefined;
  workspaceRoot: string;
  configDir?: string;
  env: NodeJS.ProcessEnv;
  keychain?: KeychainBackend;
  openUrl?: (url: string) => Promise<void> | void;
  out: (line: string) => void;
  err: (line: string) => void;
}): Promise<number> {
  const { action, name, out, err } = options;
  const userDir = options.configDir ?? configDir(options.env);
  if (action === "import") return importCmd({ source: name, configDir: userDir, env: options.env, out, err });
  if ((action !== "login" && action !== "logout") || !name) {
    err(t("cli.mcp.usage"));
    return 1;
  }
  // The servers of the daemon: those of the user's config win, and the files of a workspace count once it is trusted.
  const config = loadConfig({ globalDir: options.configDir, env: options.env });
  const trusted = createFileTrustStore(join(dataDir(options.env), "trust.json")).isTrusted(
    options.workspaceRoot,
  );
  const servers = {
    ...(trusted ? loadProjectMcpServers(options.workspaceRoot) : {}),
    ...loadUserMcpServers(userDir),
    ...config.mcpServers,
  } as Record<string, { url?: string } | undefined>;
  const url = servers[name]?.url;
  if (servers[name] === undefined) {
    err(t("cli.mcp.unknown", { name, names: Object.keys(servers).join(", ") || "-" }));
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
