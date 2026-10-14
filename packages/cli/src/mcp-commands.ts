import { join } from "node:path";
import { dataDir, loadConfig } from "@agency/core";
import { createFileTrustStore } from "@agency/guard";
import { t } from "@agency/i18n";
import { createKeychain, type KeychainBackend, openInBrowser } from "@agency/providers";
import { keychainTokenStore, loadProjectMcpServers, signInMcpServer } from "@agency/tools";

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
