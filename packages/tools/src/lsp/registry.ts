import { LspClient } from "./client.ts";

/** One configured language server: how to spawn it and which files it owns. */
export interface LspServerConfig {
  command: string;
  args?: string[];
  /** File extensions this server handles, with the dot (".ts", ".py"). */
  extensions: string[];
  /** Language id sent in textDocument/didOpen. */
  languageId: string;
}

export interface LspRegistryOptions {
  servers: readonly LspServerConfig[];
  cwd?: string;
  /** Test seam: overrides process spawning entirely. */
  clientFactory?: (config: LspServerConfig) => LspClient;
}

export interface LspRegistry {
  /** The client owning `path`, or undefined when no server claims it. */
  clientFor(path: string): LspClient | undefined;
  /** languageId for `path`'s owning server, if any. */
  languageIdFor(path: string): string | undefined;
  all(): readonly LspClient[];
  dispose(): Promise<void>;
}

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
  const clients = new Map<number, LspClient>();

  const clientFor = (path: string): LspClient | undefined => {
    const ext = extension(path);
    const config = options.servers.find((server) => server.extensions.includes(ext));
    if (!config) return undefined;
    const index = options.servers.indexOf(config);
    const existing = clients.get(index);
    if (existing) return existing;
    const client = options.clientFactory
      ? options.clientFactory(config)
      : new LspClient({
          command: config.command,
          args: config.args,
          cwd: options.cwd,
        });
    clients.set(index, client);
    return client;
  };

  return {
    clientFor,
    languageIdFor(path: string): string | undefined {
      const ext = extension(path);
      return options.servers.find((server) => server.extensions.includes(ext))?.languageId;
    },
    all: () => [...clients.values()],
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
