import type { HttpClient } from "@agency/net";
import type { ToolSpec } from "./contract.ts";
import type { DiagnosticsProvider } from "./edit-engine.ts";
import type { FormatterConfig } from "./formatter.ts";
import type { LspRegistry } from "./lsp/registry.ts";
import type { McpManagerOptions } from "./mcp/manager.ts";
import type { ProcessManager } from "./process-manager.ts";
import type { ReadState } from "./read-state.ts";
import type { ToolRegistry } from "./registry.ts";
import type { WindowsShellKind } from "./shell.ts";
import type { SnapshotStore } from "./snapshot.ts";
import type { ToolDeps } from "./contract.ts";
import type { TodoPersistence } from "./builtins/todo.ts";
import type { WebSearchConfig } from "./builtins/websearch.ts";
import type { BashState } from "./builtins/bash.ts";
import { TodoStore } from "./builtins/todo.ts";
import { createSessionScope } from "./session-scope.ts";

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
    mcpFailures: scope.mcpFailures,
    lspRegistry: scope.lspRegistry,
    dispose: scope.dispose,
  };
}
