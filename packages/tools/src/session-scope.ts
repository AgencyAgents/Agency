import { readFileSync } from "node:fs";
import type { CallerIdentity } from "@agency/guard";
import type { HttpClient } from "@agency/net";
import { type BashState, createBashTool } from "./builtins/bash.ts";
import { createBrowserTool } from "./builtins/browser.ts";
import { createEditTool } from "./builtins/edit.ts";
import { createFetchTool } from "./builtins/fetch.ts";
import { createGlobTool } from "./builtins/glob.ts";
import { createGrepTool } from "./builtins/grep.ts";
import { createExecutePlanTool } from "./builtins/plan.ts";
import { createProcessTools } from "./builtins/process.ts";
import { createQuestionTool } from "./builtins/question.ts";
import { createReadTool } from "./builtins/read.ts";
import { createTodoReadTool, createTodoWriteTool, type TodoPersistence, TodoStore } from "./builtins/todo.ts";
import { createWebSearchTool, type WebSearchConfig } from "./builtins/websearch.ts";
import { createWriteTool } from "./builtins/write.ts";
import type { ToolDeps, ToolSpec } from "./contract.ts";
import { type DiagnosticsProvider, errorDiagnostics } from "./edit-engine.ts";
import type { FormatterConfig } from "./formatter.ts";
import { normalizeLspServers, parseLspServers } from "./lsp/config.ts";
import { createLspRegistry, type LspRegistry } from "./lsp/registry.ts";
import { createLspTools } from "./lsp/tools.ts";
import {
  type McpManager,
  type McpManagerOptions,
  mcpIdentityFor,
  startMcpServersFromRaw,
} from "./mcp/manager.ts";
import { transportForWithContainerSandbox } from "./mcp/transport.ts";
import { ProcessManager } from "./process-manager.ts";
import { ReadState } from "./read-state.ts";
import { ToolRegistry } from "./registry.ts";
import { resolveShell, type WindowsShellKind } from "./shell.ts";
import { SnapshotStore } from "./snapshot.ts";

/**
 * Per-session isolated state and tool set.
 *
 * A session is a Team execution context (see TeamStore in
 * @agency/core's team/team-store.ts): the team is the persistent shared
 * abstraction: shared goal, member roster, shared todos, mailbox
 * broadcast, while the SessionScope is the per-member isolated slice of
 * runtime state that lets concurrent team members run without corrupting
 * each other's mutable state:
 * - bashState.cwd: one cwd per session (previously one mutable string daemon-wide)
 * - TodoStore: one todo list per session (previously shared; the team-level
 *   shared list lives on the Team, this store is the member's working view)
 * - ProcessManager: one process table per session (previously shared)
 * - SnapshotStore journal: per-instance in-memory journal (content-addressed blobs
 *   on disk are shared — hash-referenced, safe to share — but the undo/journal
 *   ordering is per-session so two sessions' undo stacks never interleave)
 * - ReadState: per-session read journal (write's unread-overwrite warning is session-local)
 * - ToolRegistry/tools: per-session adapted set (capability-filtered per agent)
 * - McpManager: one manager per session, keyed by sessionId in the daemon's
 *   sessionScopes map. Transports are never shared across sessions: each scope
 *   starts its own server processes/clients and dispose() closes them, so no
 *   session leaks state into another. Identity is resolved per agent handle via
 *   scope.mcpIdentityFor(serverName, handle) — never baked once at startup.
 *
 * MCP transports: MCP servers are stateless request/response over stdio/HTTP.
 * Each session gets its own McpManager (own transports/clients) for isolation;
 * transports are never shared across sessions. Each session still gets its
 * own *adapted* ToolSpec wrappers so identity/capabilities are checked
 * per-session. dispose() closes the session's transports, so deleting a
 * session never leaks server processes into other sessions.
 *
 * Similarly LSP is workspace-scoped and could be shared; each scope currently
 * may share an externally-provided LspRegistry instance when supplied.
 */
export interface SessionScope {
  tools: ToolSpec[];
  registry: ToolRegistry;
  processManager: ProcessManager;
  todos: TodoStore;
  bashState: BashState;
  readState: ReadState;
  snapshots: SnapshotStore;
  mcpFailures: ReadonlyMap<string, string>;
  mcp?: McpManager;
  mcpIdentityFor: (serverName: string, handle?: string) => CallerIdentity;
  lspRegistry?: LspRegistry;
  /** Starts deferred MCP servers (no-op once started or unconfigured).
   *  Single-flight: concurrent callers share one startup. */
  promoteMcp(): Promise<void>;
  /**
   * Owning team id when this session runs as a member of a Team
   * (team/team-store.ts). Undefined for standalone sessions.
   */
  teamId?: string;
  dispose(): Promise<void>;
}

const LSP_DIAGNOSTICS_TIMEOUT_MS = 1200;

const EMPTY_MCP_FAILURES: ReadonlyMap<string, string> = new Map();

export interface SessionScopeOptions {
  deps: ToolDeps;
  http: HttpClient;
  workspaceRoot: string;
  snapshotDir: string;
  /** Durable undo journal for this session's SnapshotStore. Defaults to the
   *  shared `<snapshotDir>/journal.jsonl`; the daemon passes a per-session
   *  file so undo stacks never interleave. */
  snapshotJournalFile?: string;
  formatter?: FormatterConfig;
  windowsShell?: WindowsShellKind;
  diagnostics?: DiagnosticsProvider;
  todoPersistence?: TodoPersistence;
  websearch?: WebSearchConfig;
  mcpServers?: unknown;
  /** Skip eager MCP startup; servers start on the first promoteMcp() call.
   *  Default false: startup timing is unchanged for existing callers. */
  mcpDeferred?: boolean;
  lspServers?: unknown;
  lspRegistry?: LspRegistry;
  mcpTransportFor?: McpManagerOptions["transportFor"];
  identityFor?: McpManagerOptions["identityFor"];
}

export async function createSessionScope(options: SessionScopeOptions): Promise<SessionScope> {
  const snapshots = new SnapshotStore(
    options.snapshotDir,
    options.snapshotJournalFile ? { journalFile: options.snapshotJournalFile } : undefined,
  );
  const formatter = options.formatter ?? {};
  const shell = resolveShell(process.platform, options.windowsShell);
  const bashState: BashState = { cwd: options.workspaceRoot };
  const processManager = new ProcessManager();
  const todos = new TodoStore(options.todoPersistence);
  const readState = new ReadState();
  const registry = new ToolRegistry();

  let lspRegistry: LspRegistry | undefined = options.lspRegistry;
  if (!lspRegistry && options.lspServers !== undefined) {
    try {
      const parsed = parseLspServers(options.lspServers);
      const normalized = normalizeLspServers(parsed);
      const servers = normalized.map((c) => ({
        command: c.command,
        args: c.args,
        extensions: c.extensions,
        languageId: c.languageId,
        env: c.env,
      }));
      if (servers.length > 0) lspRegistry = createLspRegistry({ servers, cwd: options.workspaceRoot });
    } catch {}
  }

  const lspDiagnosticsProvider: DiagnosticsProvider | undefined = lspRegistry
    ? (path: string) => {
        const client = lspRegistry?.clientFor(path);
        return client
          ? (client.diagnosticsFor(path) as readonly {
              severity: number;
              message: string;
              line: number;
              character: number;
            }[])
          : [];
      }
    : undefined;

  const combinedDiagnostics: DiagnosticsProvider | undefined = (() => {
    if (options.diagnostics && lspDiagnosticsProvider) {
      const base = options.diagnostics;
      return (path: string) => [...base(path), ...lspDiagnosticsProvider(path)];
    }
    return options.diagnostics ?? lspDiagnosticsProvider;
  })();

  const readSpec = createReadTool(options.deps, { readState });
  const writeSpec = createWriteTool(options.deps, snapshots, formatter, { readState });
  const editSpec = createEditTool(options.deps, snapshots, formatter, {
    diagnostics: combinedDiagnostics,
    readState,
  });

  registry.register(readSpec);
  registry.register(writeSpec);
  registry.register(editSpec);
  registry.register(createBashTool(options.deps, shell, bashState, processManager));
  registry.register(createGrepTool(options.deps));
  registry.register(createGlobTool(options.deps));
  registry.register(createFetchTool(options.deps, options.http));
  registry.registerDeferred("browser", () => createBrowserTool(options.deps, options.http), {
    riskTier: "moderate",
    description:
      "Headless-browser minimum without bundled chromium: navigate fetches a page over HTTP(S), " +
      "snapshot returns an accessibility-tree-like view (title, headings, links, text), close discards " +
      "the page. Screenshots are unavailable in this build (use snapshot).",
  });
  registry.register(createTodoReadTool(todos));
  registry.register(createTodoWriteTool(todos));
  registry.register(createExecutePlanTool(options.deps, todos));
  for (const tool of createProcessTools(options.deps, processManager)) {
    registry.register(tool);
  }
  registry.register(createQuestionTool());
  if (options.websearch?.endpoint) {
    registry.register(createWebSearchTool(options.deps, options.http, options.websearch));
  }
  if (lspRegistry) {
    for (const tool of createLspTools({ deps: options.deps, registry: lspRegistry })) {
      registry.register(tool);
    }
  }

  if (lspRegistry) {
    const wrapRead = registry.get("read");
    if (wrapRead) {
      const orig = wrapRead.handler;
      wrapRead.handler = async (input: unknown, ctx) => {
        const result = await orig(input as Record<string, unknown>, ctx);
        if (!result.isError) {
          try {
            const p = (input as { path?: string }).path;
            if (typeof p === "string") {
              const resolved = options.deps.sandbox.resolvePath(p);
              const client = lspRegistry?.clientFor(resolved);
              if (client) {
                const languageId = lspRegistry?.languageIdFor(resolved) ?? "plaintext";
                let text: string;
                try {
                  text = readFileSync(resolved, "utf8");
                } catch {
                  text = result.content;
                }
                try {
                  await client.ready;
                } catch {}
                client.open(resolved, text, languageId);
              }
            }
          } catch {}
        }
        return result;
      };
    }

    const attachDiagnostics = async (
      resolved: string,
      baseResult: { content: string; isError?: boolean },
    ): Promise<{ content: string; isError?: boolean }> => {
      if (baseResult.isError) return baseResult;
      const client = lspRegistry?.clientFor(resolved);
      if (!client) return baseResult;
      try {
        await client.ready;
      } catch {
        return baseResult;
      }
      let text: string;
      try {
        text = readFileSync(resolved, "utf8");
      } catch {
        return baseResult;
      }
      const languageId = lspRegistry?.languageIdFor(resolved);
      if (lspRegistry?.all().length > 0) {
        try {
          const existingDiags = client.diagnosticsFor(resolved);
          if (existingDiags.length === 0) {
            client.open(resolved, text, languageId ?? "plaintext");
          }
          client.change(resolved, text);
        } catch {}
      }
      let diags: readonly { severity: number; message: string; line: number; character: number }[] = [];
      try {
        const withTimeout = await Promise.race([
          client.waitForDiagnostics(resolved, LSP_DIAGNOSTICS_TIMEOUT_MS),
          new Promise<readonly { severity: number; message: string; line: number; character: number }[]>(
            (resolve) =>
              setTimeout(
                () =>
                  resolve(
                    client.diagnosticsFor(resolved) as readonly {
                      severity: number;
                      message: string;
                      line: number;
                      character: number;
                    }[],
                  ),
                1300,
              ),
          ),
        ]);
        diags = withTimeout;
      } catch {
        diags = client.diagnosticsFor(resolved) as readonly {
          severity: number;
          message: string;
          line: number;
          character: number;
        }[];
      }
      const warnings = errorDiagnostics(diags);
      if (warnings.length === 0) return baseResult;
      const suffix = `\nDiagnostics:\n${warnings.join("\n")}`;
      return { ...baseResult, content: baseResult.content + suffix };
    };

    const wrapWrite = registry.get("write");
    if (wrapWrite) {
      const orig = wrapWrite.handler;
      wrapWrite.handler = async (input: unknown, ctx) => {
        const result = await orig(input as Record<string, unknown>, ctx);
        try {
          const p = (input as { path?: string }).path;
          if (typeof p === "string") {
            const resolved = options.deps.sandbox.resolvePath(p);
            const withDiags = await attachDiagnostics(resolved, result);
            return withDiags as typeof result;
          }
        } catch {}
        return result;
      };
    }

    const wrapEdit = registry.get("edit");
    if (wrapEdit) {
      const orig = wrapEdit.handler;
      wrapEdit.handler = async (input: unknown, ctx) => {
        const result = await orig(input as Record<string, unknown>, ctx);
        try {
          const p = (input as { path?: string }).path;
          if (typeof p === "string") {
            const resolved = options.deps.sandbox.resolvePath(p);
            const withDiags = await attachDiagnostics(resolved, result);
            return withDiags as typeof result;
          }
        } catch {}
        return result;
      };
    }
  }

  let mcp: McpManager | undefined;
  let mcpInflight: Promise<void> | undefined;
  const startMcp = async (): Promise<void> => {
    // Explicit transportFor wins; a container sandbox routes stdio across
    // the mount (software yields undefined, keeping the default spawn path).
    const containerTransportFor = transportForWithContainerSandbox(options.deps.sandbox, {
      cwd: options.workspaceRoot,
      adopt: (proc, command) => processManager.adopt(proc, command),
    });
    mcp = await startMcpServersFromRaw(options.mcpServers, {
      capabilities: options.deps.capabilities,
      processManager,
      transportFor: options.mcpTransportFor ?? containerTransportFor,
      registry,
      identityFor: options.identityFor,
    });
  };
  const promoteMcp = async (): Promise<void> => {
    if (options.mcpServers === undefined || mcp !== undefined) return;
    if (!mcpInflight) {
      mcpInflight = startMcp().finally(() => {
        mcpInflight = undefined;
      });
    }
    return mcpInflight;
  };
  if (options.mcpServers !== undefined && !options.mcpDeferred) {
    await startMcp();
  }
  const mcpIdentityForScope = (serverName: string, handle?: string): CallerIdentity =>
    (options.identityFor ?? mcpIdentityFor)(serverName, handle);

  return {
    tools: registry.list(),
    registry,
    processManager,
    todos,
    bashState,
    readState,
    snapshots,
    get mcpFailures(): ReadonlyMap<string, string> {
      return mcp?.failures ?? EMPTY_MCP_FAILURES;
    },
    get mcp(): McpManager | undefined {
      return mcp;
    },
    mcpIdentityFor: mcpIdentityForScope,
    lspRegistry,
    promoteMcp,
    async dispose() {
      // Each scope owns its ProcessManager (kills background dev servers/watchers
      // started in that session) and its MCP clients (stdio transports). LSP is
      // intentionally per-scope lifecycle for now; shared registries passed in
      // via options.lspRegistry are the caller's responsibility to dispose only
      // when the last scope goes away, so we only dispose registries we created.
      processManager.killAll();
      await mcp?.dispose();
      if (lspRegistry && lspRegistry !== options.lspRegistry) {
        // Only dispose registry we created internally
        // If caller supplied shared registry, they handle its lifecycle
        if (options.lspServers !== undefined) await lspRegistry.dispose();
      } else if (lspRegistry && !options.lspRegistry) {
        await lspRegistry.dispose();
      }
    },
  };
}
