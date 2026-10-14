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
