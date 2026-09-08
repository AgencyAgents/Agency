import type { HttpClient } from "@agency/net";
import type { BashState } from "./builtins/bash.ts";
import type { TodoPersistence, TodoStore } from "./builtins/todo.ts";
import type { WebSearchConfig } from "./builtins/websearch.ts";
import type { ToolDeps, ToolSpec } from "./contract.ts";
import type { DiagnosticsProvider } from "./edit-engine.ts";
import type { FormatterConfig } from "./formatter.ts";
import type { LspRegistry } from "./lsp/registry.ts";
import type { McpManagerOptions } from "./mcp/manager.ts";
import type { ProcessManager } from "./process-manager.ts";
import type { ReadState } from "./read-state.ts";
import type { ToolRegistry } from "./registry.ts";
import { createSessionScope } from "./session-scope.ts";
import type { WindowsShellKind } from "./shell.ts";
import type { SnapshotStore } from "./snapshot.ts";

export interface BuiltinToolsOptions {
  deps: ToolDeps;
  http: HttpClient;
  workspaceRoot: string;
  snapshotDir: string;
  formatter?: FormatterConfig;
  windowsShell?: WindowsShellKind;
  diagnostics?: DiagnosticsProvider;
  todoPersistence?: TodoPersistence;
  websearch?: WebSearchConfig;
  mcpServers?: unknown;
  mcpDeferred?: boolean;
  lspServers?: unknown;
  lspRegistry?: LspRegistry;
  mcpTransportFor?: McpManagerOptions["transportFor"];
}

export interface BuiltinTools {
  tools: ToolSpec[];
  registry: ToolRegistry;
  processManager: ProcessManager;
  todos: TodoStore;
  bashState: BashState;
  readState: ReadState;
  snapshots: SnapshotStore;
  mcpFailures: ReadonlyMap<string, string>;
  lspRegistry?: LspRegistry;
  promoteMcp(): Promise<void>;
  dispose(): Promise<void>;
}

/** Backward-compatible single-session wrapper over createSessionScope. */
export async function createBuiltinTools(options: BuiltinToolsOptions): Promise<BuiltinTools> {
  const scope = await createSessionScope(options);
  return {
    tools: scope.tools,
    registry: scope.registry,
    processManager: scope.processManager,
    todos: scope.todos,
    bashState: scope.bashState,
    readState: scope.readState,
    snapshots: scope.snapshots,
    get mcpFailures(): ReadonlyMap<string, string> {
      return scope.mcpFailures;
    },
    lspRegistry: scope.lspRegistry,
    promoteMcp: scope.promoteMcp,
    dispose: scope.dispose,
  };
}
