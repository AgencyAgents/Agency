import { LspClient } from "./client.ts";

/** One configured language server: how to spawn it and which files it owns. */
export interface LspServerConfig {
  command: string;
  args?: string[];
  /** File extensions this server handles, with the dot (".ts", ".py"). */
  extensions: string[];
  /** Language id sent in textDocument/didOpen. */
  languageId: string;
  /** Extra env vars for the server process. */
  env?: Record<string, string>;
}

export interface LspRegistryOptions {
  servers: readonly LspServerConfig[];
  cwd?: string;
  /** Test seam: overrides process spawning entirely. */
  clientFactory?: (config: LspServerConfig) => LspClient;
}

export type LspInstallDecision = "allowed" | "declined";

export interface LspRegistry {
  /** The client owning `path`, or undefined when no server claims it. */
  clientFor(path: string): LspClient | undefined;
  /** languageId for `path`'s owning server, if any. */
  languageIdFor(path: string): string | undefined;
  all(): readonly LspClient[];
  dispose(): Promise<void>;
  /** Snapshot of current server statuses: "running" | "failed: reason". */
  statuses(): Record<string, string>;
  /** Records the user's install decision for a server command. */
  recordInstallDecision(server: string, decision: LspInstallDecision): void;
  /** The recorded install decision for a server command, if any. */
  installDecisionFor(server: string): LspInstallDecision | undefined;
}

const normalizeExt = (ext: string): string => {
  const lower = ext.toLowerCase();
  return lower.startsWith(".") ? lower : `.${lower}`;
};

const extension = (path: string): string => {
  const dot = path.lastIndexOf(".");
  return dot === -1 ? "" : path.slice(dot).toLowerCase();
};

/**
 * Routes file paths to their language server. Servers spawn lazily via the
 * factory (the real factory is LspClient construction); a server that fails
 * to spawn surfaces through its client's ready promise, never through the
 * registry — an edit must never fail because a language server is missing.
 */
export function createLspRegistry(options: LspRegistryOptions): LspRegistry {
  const normalizedServers = options.servers.map((s) => ({
    ...s,
    extensions: s.extensions.map(normalizeExt),
  }));
  const clients = new Map<number, LspClient>();
  const configByIndex = new Map<number, LspServerConfig>();
  const failures = new Map<number, string>();
  const installDecisions = new Map<string, LspInstallDecision>();
  for (let i = 0; i < normalizedServers.length; i++) {
    const cfg = normalizedServers[i];
    if (cfg !== undefined) configByIndex.set(i, cfg);
  }

  const findConfig = (path: string): { config: LspServerConfig; index: number } | undefined => {
    const ext = extension(path);
    const index = normalizedServers.findIndex((server) => server.extensions.includes(ext));
    if (index === -1) return undefined;
    const config = normalizedServers[index];
    if (config === undefined) return undefined;
    return { config, index };
  };

  const clientFor = (path: string): LspClient | undefined => {
    const found = findConfig(path);
    if (!found) return undefined;
    const { config, index } = found;
    const existing = clients.get(index);
    if (existing) return existing;
    const client = options.clientFactory
      ? options.clientFactory(config)
      : new LspClient({
          command: config.command,
          args: config.args,
          cwd: options.cwd,
          env: config.env,
        });
    clients.set(index, client);
    client.ready.catch((err: unknown) => {
      failures.set(index, err instanceof Error ? err.message : String(err));
    });
    return client;
  };

  return {
    clientFor,
    languageIdFor(path: string): string | undefined {
      return findConfig(path)?.config.languageId;
    },
    all: () => [...clients.values()],
    statuses() {
      const out: Record<string, string> = {};
      for (const [idx, cfg] of configByIndex) {
        if (failures.has(idx)) out[cfg.command] = `failed: ${failures.get(idx)}`;
        else if (clients.has(idx)) out[cfg.command] = "running";
        else {
          const decision = installDecisions.get(cfg.command);
          out[cfg.command] = decision === "declined" ? "declined: user declined install" : "idle";
        }
      }
      return out;
    },
    recordInstallDecision(server: string, decision: LspInstallDecision): void {
      installDecisions.set(server, decision);
    },
    installDecisionFor(server: string): LspInstallDecision | undefined {
      return installDecisions.get(server);
    },
    async dispose() {
      for (const client of clients.values()) {
        try {
          await client.close();
        } catch {}
      }
      clients.clear();
    },
  };
}
