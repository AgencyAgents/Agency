import type { HttpClient } from "@agency/net";
import { type BashState, createBashTool } from "./builtins/bash.ts";
import { createEditTool } from "./builtins/edit.ts";
import { createFetchTool } from "./builtins/fetch.ts";
import { createGlobTool } from "./builtins/glob.ts";
import { createGrepTool } from "./builtins/grep.ts";
import { createExecutePlanTool } from "./builtins/plan.ts";
import { createProcessTools } from "./builtins/process.ts";
import { createQuestionTool } from "./builtins/question.ts";
import { createReadTool } from "./builtins/read.ts";
import { createTodoReadTool, createTodoWriteTool, TodoStore, type TodoPersistence } from "./builtins/todo.ts";
import { createWebSearchTool, type WebSearchConfig } from "./builtins/websearch.ts";
import { createWriteTool } from "./builtins/write.ts";
import type { ToolDeps, ToolSpec } from "./contract.ts";
import type { DiagnosticsProvider } from "./edit-engine.ts";
import type { FormatterConfig } from "./formatter.ts";
import { type McpManager, type McpManagerOptions, startMcpServersFromRaw } from "./mcp/manager.ts";
import { ProcessManager } from "./process-manager.ts";
import { ReadState } from "./read-state.ts";
import { ToolRegistry } from "./registry.ts";
import { resolveShell, type WindowsShellKind } from "./shell.ts";
import { SnapshotStore } from "./snapshot.ts";
export interface BuiltinToolsOptions {
  deps: ToolDeps;
  http: HttpClient;
  workspaceRoot: string;
  snapshotDir: string;
  formatter?: FormatterConfig;
  windowsShell?: WindowsShellKind;
  /** LSP diagnostics seam for edit verification; absent means no verification. */
  diagnostics?: DiagnosticsProvider;
  /** Todo persistence (session-entry backed); absent means in-memory todos. */
  todoPersistence?: TodoPersistence;
  /** Web search config; when set with an endpoint the websearch tool registers. */
  websearch?: WebSearchConfig;
  /** Raw `mcpServers` config; parsed and started when present. */
  mcpServers?: unknown;
  /** Test seam: overrides MCP transport creation. */
  mcpTransportFor?: McpManagerOptions["transportFor"];
}

export interface BuiltinTools {
  /** The flat tool list (backward compatible): registry.list() at build time. */
  tools: ToolSpec[];
  /** Dynamic registry the flat list came from — A8 plugins and B1 agent subsets register here. */
  registry: ToolRegistry;
  processManager: ProcessManager;
  todos: TodoStore;
  bashState: BashState;
  /** Files the model has read this session, backing write's unread-overwrite warning. */
  readState: ReadState;
  /** File-write journal backing undo/redo; entries are indexed per turn. */
  snapshots: SnapshotStore;
  /** MCP servers that failed to start, by name (start failures never abort the set). */
  mcpFailures: ReadonlyMap<string, string>;
  /** Stops every MCP server; idempotent. */
  dispose(): Promise<void>;
}

/** Assembles the full built-in set: read, write, edit, bash, grep, glob,
 *  fetch, todo_read, todo_write, execute_plan, the process_* trio, question,
 *  plus websearch when configured and any configured MCP servers' tools,
 *  wired to shared state (snapshots, todos, read journal, bash cwd, process
 *  manager) scoped to one session. */
export async function createBuiltinTools(options: BuiltinToolsOptions): Promise<BuiltinTools> {
  const snapshots = new SnapshotStore(options.snapshotDir);
  const formatter = options.formatter ?? {};
  const shell = resolveShell(process.platform, options.windowsShell);
  const bashState: BashState = { cwd: options.workspaceRoot };
  const processManager = new ProcessManager();
  const todos = new TodoStore(options.todoPersistence);
  const readState = new ReadState();
  const registry = new ToolRegistry();

  registry.register(createReadTool(options.deps, { readState }));
  registry.register(createWriteTool(options.deps, snapshots, formatter, { readState }));
  registry.register(createEditTool(options.deps, snapshots, formatter, { diagnostics: options.diagnostics, readState }));
  registry.register(createBashTool(options.deps, shell, bashState, processManager));
  registry.register(createGrepTool(options.deps));
  registry.register(createGlobTool(options.deps));
  registry.register(createFetchTool(options.deps, options.http));
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

  let mcp: McpManager | undefined;
  if (options.mcpServers !== undefined) {
    mcp = await startMcpServersFromRaw(options.mcpServers, {
      capabilities: options.deps.capabilities,
      processManager,
      transportFor: options.mcpTransportFor,
    });
    // MCP adapter names are already `<server>_<tool>`; a genuine name
    // collision with a built-in throws, which is the right outcome for a
    // misconfigured server.
    for (const tool of mcp.tools) registry.register(tool);
  }

  return {
    tools: registry.list(),
    registry,
    processManager,
    todos,
    bashState,
    readState,
    snapshots,
    mcpFailures: mcp?.failures ?? new Map(),
    async dispose() {
      await mcp?.dispose();
    },
  };
}