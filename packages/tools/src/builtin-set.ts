import type { HttpClient } from "@agency/net";
import { type BashState, createBashTool } from "./builtins/bash.ts";
import { createEditTool } from "./builtins/edit.ts";
import { createFetchTool } from "./builtins/fetch.ts";
import { createGlobTool } from "./builtins/glob.ts";
import { createGrepTool } from "./builtins/grep.ts";
import { createReadTool } from "./builtins/read.ts";
import { createTodoReadTool, createTodoWriteTool, TodoStore } from "./builtins/todo.ts";
import { createWriteTool } from "./builtins/write.ts";
import type { ToolDeps, ToolSpec } from "./contract.ts";
import type { FormatterConfig } from "./formatter.ts";
import { type McpManager, type McpManagerOptions, startMcpServersFromRaw } from "./mcp/manager.ts";
import { ProcessManager } from "./process-manager.ts";
import { resolveShell, type WindowsShellKind } from "./shell.ts";
import { SnapshotStore } from "./snapshot.ts";
export interface BuiltinToolsOptions {
  deps: ToolDeps;
  http: HttpClient;
  workspaceRoot: string;
  snapshotDir: string;
  formatter?: FormatterConfig;
  windowsShell?: WindowsShellKind;
  /** Raw `mcpServers` config; parsed and started when present. */
  mcpServers?: unknown;
  /** Test seam: overrides MCP transport creation. */
  mcpTransportFor?: McpManagerOptions["transportFor"];
}

export interface BuiltinTools {
  tools: ToolSpec[];
  processManager: ProcessManager;
  todos: TodoStore;
  bashState: BashState;
  /** File-write journal backing undo/redo; entries are indexed per turn. */
  snapshots: SnapshotStore;
  /** MCP servers that failed to start, by name (start failures never abort the set). */
  mcpFailures: ReadonlyMap<string, string>;
  /** Stops every MCP server; idempotent. */
  dispose(): Promise<void>;
}

/** Assembles the full built-in set: read, write, edit, bash, grep, glob,
 *  fetch, todo_read, todo_write, plus any configured MCP servers' tools,
 *  wired to shared state (snapshots, todos, bash cwd, process manager)
 *  scoped to one session. */
export async function createBuiltinTools(options: BuiltinToolsOptions): Promise<BuiltinTools> {
  const snapshots = new SnapshotStore(options.snapshotDir);
  const formatter = options.formatter ?? {};
  const shell = resolveShell(process.platform, options.windowsShell);
  const bashState: BashState = { cwd: options.workspaceRoot };
  const processManager = new ProcessManager();
  const todos = new TodoStore();

  const tools: ToolSpec[] = [
    createReadTool(options.deps),
    createWriteTool(options.deps, snapshots, formatter),
    createEditTool(options.deps, snapshots, formatter),
    createBashTool(options.deps, shell, bashState, processManager),
    createGrepTool(options.deps),
    createGlobTool(options.deps),
    createFetchTool(options.deps, options.http),
    createTodoReadTool(todos),
    createTodoWriteTool(todos),
  ];

  let mcp: McpManager | undefined;
  if (options.mcpServers !== undefined) {
    mcp = await startMcpServersFromRaw(options.mcpServers, {
      capabilities: options.deps.capabilities,
      processManager,
      transportFor: options.mcpTransportFor,
    });
    tools.push(...mcp.tools);
  }

  return {
    tools,
    processManager,
    todos,
    bashState,
    snapshots,
    mcpFailures: mcp?.failures ?? new Map(),
    async dispose() {
      await mcp?.dispose();
    },
  };
}
