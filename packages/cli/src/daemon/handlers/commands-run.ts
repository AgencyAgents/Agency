import {
  compact,
  defaultGitRunner,
  expandCommand,
  initDeep,
  renderCommandHelp,
  resolveCommand,
  splitCommandArgs,
  summarizeTranscript,
  unknownCommandMessage,
} from "@agency/core";
import { tokenizerFor } from "@agency/providers";
import type { MethodHandler } from "@agency/rpc";
import { AgencyError, ErrorCode } from "@agency/schema";
import type { DaemonContext } from "../types.ts";

export interface CommandRunResult {
  name: string;
  kind: "builtin" | "template" | "plugin";
  text: string;
  data?: unknown;
  action?: "exit";
  source?: string;
  pluginId?: string;
}

type BuiltinResult = Omit<CommandRunResult, "name" | "kind">;
type BuiltinFn = (
  ctx: DaemonContext,
  handlers: Record<string, MethodHandler>,
  args: string[],
) => Promise<BuiltinResult>;

function fail(message: string): never {
  throw new AgencyError(ErrorCode.INTERNAL, message, { source: "command_run" });
}

async function call<T>(
  handlers: Record<string, MethodHandler>,
  method: string,
  params: Record<string, unknown>,
): Promise<T> {
  const fn = handlers[method];
  if (!fn) fail(`command backing missing: ${method}`);
  return (await fn(params, { clientId: "command_run" })) as unknown as T;
}

function textOf(value: unknown): string {
  return typeof value === "string" ? value : "";
}

const BUILTINS: Record<string, BuiltinFn> = {
  help: async (ctx) => {
    const text = renderCommandHelp({ templates: ctx.commands, pluginCommands: ctx.pluginCommands });
    return { text, data: { count: 33 + ctx.commands.length + ctx.pluginCommands.length } };
  },
  init: async (ctx) => {
    const result = initDeep(ctx.options.workspaceRoot);
    return {
      text: `init: ${result.created.length} created, ${result.skipped.length} skipped`,
      data: result,
    };
  },
  new: async (_ctx, handlers, args) => {
    const id = args[0];
    const data = await call<{ sessionId: string }>(handlers, "session_create", id ? { sessionId: id } : {});
    return { text: `created session ${data.sessionId}`, data };
  },
  compact: async (ctx, handlers, args) => {
    void handlers;
    const sessionId = args[0];
    if (!sessionId) fail("compact requires a session id (/compact <session>)");
    const entries = ctx.todoStore.load(sessionId);
    const tip = ctx.todoStore.latestTip(entries) ?? null;
    if (!tip) return { text: `session ${sessionId} is empty, nothing to compact`, data: { sessionId } };
    const model = args[1] ?? textOf((ctx.config as { model?: unknown }).model) ?? "";
    const catalogHit = ctx.listModels().find((m) => m.id === model);
    const slash = model.indexOf("/");
    const family =
      catalogHit?.family ??
      (slash > 0 ? model.slice(0, slash) : undefined) ??
      ctx.providers[model]?.family ??
      "anthropic";
    const outcome = await compact(
      ctx.todoStore,
      sessionId,
      tip,
      tokenizerFor(family),
      { contextWindow: 200_000 },
      (text: string) => Promise.resolve(summarizeTranscript(text)),
    );
    return {
      text: outcome.compacted ? `compacted ${sessionId} to ${outcome.tipId}` : `${sessionId} below threshold`,
      data: { sessionId, ...outcome },
    };
  },
  model: async (ctx, handlers, args) => {
    const wanted = args[0];
    const models = await call<{ models: { id: string; family: string }[] }>(handlers, "models_list", {});
    if (!wanted) {
      const current = textOf((ctx.config as { model?: unknown }).model) || "(unset)";
      return {
        text: `model ${current} (${models.models.length} known)`,
        data: { current, models: models.models },
      };
    }
    const hit = models.models.some((m) => m.id === wanted || `${m.family}/${m.id}` === wanted);
    if (!hit) fail(`unknown model: ${wanted}`);
    const data = await call<{ key: string; value: unknown }>(handlers, "config_set", {
      key: "model",
      value: wanted,
    });
    return { text: `model set to ${wanted} (memory-only until restart)`, data };
  },
  sessions: async (_ctx, handlers) => {
    const data = await call<{ sessions: { id: string }[] }>(handlers, "session_list", {});
    return { text: `${data.sessions.length} session(s)`, data };
  },
  undo: async (_ctx, handlers, args) => {
    const data = await call<{ undone: boolean; path?: string }>(
      handlers,
      "undo",
      args[0] ? { sessionId: args[0] } : {},
    );
    return { text: data.undone ? `undone ${data.path ?? ""}`.trim() : "nothing to undo", data };
  },
  redo: async (_ctx, handlers, args) => {
    const data = await call<{ undone: boolean; path?: string }>(
      handlers,
      "redo",
      args[0] ? { sessionId: args[0] } : {},
    );
    return { text: data.undone ? `redone ${data.path ?? ""}`.trim() : "nothing to redo", data };
  },
  exit: async () => ({ text: "closing this session", action: "exit" as const }),
  agents: async (_ctx, handlers, args) => {
    const data = await call<unknown[] | { agents?: unknown }>(
      handlers,
      "agents_list",
      args[0] ? { sessionId: args[0] } : {},
    );
    const rows = Array.isArray(data) ? data : ((data as { agents?: unknown }).agents ?? data);
    const count = Array.isArray(rows) ? rows.length : 0;
    return { text: `${count} agent(s)`, data };
  },
  team: async (_ctx, handlers, args) => {
    const data = await call<{ agents: unknown[]; todo: unknown[] }>(
      handlers,
      "team_status",
      args[0] ? { sessionId: args[0] } : {},
    );
    return { text: `${data.agents.length} agent(s), ${data.todo.length} todo(s)`, data };
  },
  todos: async (_ctx, handlers, args) => {
    const sessionId = args[0];
    if (!sessionId) fail("todos requires a session id (/todos <session>)");
    const data = await call<{ todos: unknown[] }>(handlers, "todo_read", { sessionId });
    return { text: `${data.todos.length} todo(s) in ${sessionId}`, data };
  },
  status: async (_ctx, handlers, args) => {
    const sessionId = args[0];
    if (!sessionId) fail("status requires a session id (/status <session>)");
    const data = await call<{ messages: unknown[]; tipId: string }>(handlers, "session_show", { sessionId });
    return { text: `${sessionId}: ${data.messages.length} message(s), tip ${data.tipId}`, data };
  },
  stop: async (_ctx, handlers, args) => {
    const data = await call<{ stopped: boolean }>(
      handlers,
      "team_stop",
      args[0] ? { sessionId: args[0] } : {},
    );
    return { text: data.stopped ? "team stopped" : "nothing running", data };
  },
  cost: async (_ctx, handlers, args) => {
    const data = await call<{ runTotalUsd: number; total: { turns: number } }>(
      handlers,
      "cost_report",
      args[0] ? { sessionId: args[0] } : {},
    );
    return { text: `run $${data.runTotalUsd.toFixed(4)} over ${data.total.turns} turn(s)`, data };
  },
  plan: async (_ctx, handlers, args) => {
    const path = args[0];
    if (!path) fail("plan requires a plan path (/plan <path>)");
    const data = await call<{ record: unknown }>(
      handlers,
      "plan_approve",
      args[1] ? { path, approvedBy: args[1] } : { path },
    );
    return { text: `plan approved: ${path}`, data };
  },
  approve: async (_ctx, handlers, args) => {
    const [requestId, decision, sessionId] = args;
    if (!requestId || !decision)
      fail("approve requires id and decision (/approve <id> <once|always|reject>)");
    if (decision !== "once" && decision !== "always" && decision !== "reject") {
      fail(`invalid approval decision: ${decision}`);
    }
    const data = await call<{ resolved: boolean }>(
      handlers,
      "approval_respond",
      sessionId ? { requestId, decision, sessionId } : { requestId, decision },
    );
    return {
      text: data.resolved ? `approval ${requestId} ${decision}` : `no pending ask ${requestId}`,
      data,
    };
  },
  inspect: async (_ctx, handlers, args) => {
    const handle = args[0];
    if (!handle) fail("inspect requires an agent handle (/inspect <agent> [step])");
    const second = args[1];
    const params: Record<string, unknown> = { handle, requester: "lead", isLead: true };
    if (second === undefined) params.granularity = "timeline";
    else if (/^\d+$/.test(second)) {
      params.granularity = "step";
      params.step = Number(second);
    } else if (second === "timeline" || second === "reasoning") {
      params.granularity = second;
      if (args[2] !== undefined && /^\d+$/.test(args[2])) params.since = Number(args[2]);
    } else if (second === "step") {
      params.granularity = "step";
      if (args[2] === undefined || !/^\d+$/.test(args[2])) fail("inspect step requires a step number");
      params.step = Number(args[2]);
    } else fail(`unknown inspect granularity: ${second}`);
    const data = await call<{ handle: string; granularity: string }>(handlers, "agent_inspect", params);
    return { text: `inspect ${handle} (${String(params.granularity)})`, data };
  },
  graph: async (_ctx, handlers, args) => {
    const data = await call<{ nodes: { kind: string }[] }>(
      handlers,
      "activity_graph",
      args[0] ? { sessionId: args[0] } : {},
    );
    const agents = data.nodes.filter((n) => n.kind === "agent").length;
    const tasks = data.nodes.filter((n) => n.kind === "task").length;
    return { text: `${agents} agent(s), ${tasks} task(s)`, data };
  },
  decisions: async (_ctx, handlers) => {
    const data = await call<{ decisions: unknown[] }>(handlers, "decisions_read", {});
    return { text: `${data.decisions.length} decision(s)`, data };
  },
  owners: async (_ctx, handlers, args) => {
    const path = args[0];
    if (!path) fail("owners requires a path (/owners <path>)");
    const data = await call<{ handles: string[] }>(handlers, "owners_read", { path });
    return { text: `${path}: ${data.handles.join(", ") || "(unowned)"}`, data };
  },
  "undo-run": async (_ctx, handlers, args) => {
    const sessionId = args[0];
    if (!sessionId) fail("undo-run requires a session id (/undo-run <session>)");
    const data = await call<{ undone: boolean; reason?: string }>(handlers, "undo_run", { sessionId });
    return { text: data.undone ? `rolled back ${sessionId}` : `nothing to roll back: ${data.reason}`, data };
  },
  trace: async (_ctx, handlers, args) => {
    const sessionId = args[0];
    if (!sessionId) fail("trace requires a session id (/trace <session> [turn])");
    const data = await call<{ spans: unknown[] }>(
      handlers,
      "trace_get",
      args[1] ? { sessionId, turnId: args[1] } : { sessionId },
    );
    return { text: `${data.spans.length} span(s) in ${sessionId}`, data };
  },
  replay: async (_ctx, handlers, args) => {
    const [sessionId, turnId, model] = args;
    if (!sessionId || !turnId) fail("replay requires session and turn (/replay <session> <turn>)");
    const data = await call<{ equal: boolean; original: unknown }>(
      handlers,
      "trace_replay",
      model ? { sessionId, turnId, overrides: { model } } : { sessionId, turnId },
    );
    return { text: data.equal ? "replay matches the recording" : "replay differs from the recording", data };
  },
  diff: async (ctx) => {
    const stat = defaultGitRunner(ctx.options.workspaceRoot, ["diff", "--stat"]);
    const status = defaultGitRunner(ctx.options.workspaceRoot, ["status", "--porcelain"]);
    if (stat === null && status === null) {
      return { text: "not a git repo (or git unavailable)", data: { stat: null, status: null } };
    }
    return { text: [stat ?? "(no diff)", status ?? "(clean)"].join("\n"), data: { stat, status } };
  },
  export: async (_ctx, handlers, args) => {
    const sessionId = args[0];
    if (!sessionId) fail("export requires a session id (/export <session>)");
    const data = await call<{ entries: unknown[] }>(handlers, "session_export", { sessionId });
    return { text: `${data.entries.length} entr(ies) in ${sessionId}`, data };
  },
  mcp: async (_ctx, handlers, args) => {
    const data = await call<{ failures: Record<string, string> }>(
      handlers,
      "mcp_status",
      args[0] ? { sessionId: args[0] } : {},
    );
    const count = Object.keys(data.failures).length;
    return { text: count === 0 ? "no MCP failures" : `${count} MCP failure(s)`, data };
  },
  lsp: async (_ctx, handlers, args) => {
    const data = await call<{ statuses: Record<string, string> }>(
      handlers,
      "lsp_status",
      args[0] ? { sessionId: args[0] } : {},
    );
    const count = Object.keys(data.statuses).length;
    return { text: `${count} language server(s)`, data };
  },
  permissions: async (_ctx, handlers, args) => {
    const data = await call<{ permissions: unknown; capabilities: unknown }>(
      handlers,
      "permissions_list",
      args[0] ? { sessionId: args[0] } : {},
    );
    return { text: "permission maps plus offered tools", data };
  },
  trust: async (ctx) => {
    const data = {
      trusted: ctx.trustStore.isTrusted(ctx.options.workspaceRoot),
      path: ctx.options.workspaceRoot,
    };
    return { text: data.trusted ? `${data.path} is trusted` : `${data.path} is not trusted`, data };
  },
  debug: async (_ctx, handlers, args) => {
    const prompt = await call<{ prompt: string }>(handlers, "prompt_inspect", {});
    if (!args[0]) {
      return { text: `prompt resolves to ${prompt.prompt.length} chars`, data: { prompt } };
    }
    const view = await call<{ tipId: string }>(handlers, "session_show", { sessionId: args[0] });
    return {
      text: `prompt ${prompt.prompt.length} chars, ${args[0]} at tip ${view.tipId}`,
      data: { prompt, session: args[0], tipId: view.tipId },
    };
  },
  doctor: async (ctx, handlers) => {
    const providers = await call<{ all: unknown[] }>(handlers, "providers_list", {});
    const models = await call<{ models: unknown[] }>(handlers, "models_list", {});
    const sessions = await call<{ sessions: unknown[] }>(handlers, "session_list", {});
    const trusted = ctx.trustStore.isTrusted(ctx.options.workspaceRoot);
    const checks = [
      { name: "providers", ok: providers.all.length > 0, detail: `${providers.all.length} known` },
      { name: "models", ok: models.models.length > 0, detail: `${models.models.length} known` },
      { name: "trust", ok: trusted, detail: ctx.options.workspaceRoot },
      { name: "sessions", ok: true, detail: `${sessions.sessions.length} known` },
    ];
    const bad = checks.filter((c) => !c.ok);
    return {
      text: bad.length === 0 ? "all checks pass" : `failing: ${bad.map((c) => c.name).join(", ")}`,
      data: { checks },
    };
  },
  goal: async (_ctx, handlers, args) => {
    const data = await call<{ goal?: string; outcome?: string }>(
      handlers,
      "report_get",
      args[0] ? { outcome: args[0] } : {},
    );
    return {
      text: `goal: ${data.goal ?? "(none)"} (${data.outcome ?? "complete"})`,
      data,
    };
  },
};

export async function runCommand(
  ctx: DaemonContext,
  handlers: Record<string, MethodHandler>,
  rawParams: unknown,
): Promise<CommandRunResult> {
  const params = (rawParams ?? {}) as { name?: unknown; args?: unknown };
  const rawName = typeof params.name === "string" ? params.name.trim() : "";
  const name = rawName.startsWith("/") ? rawName.slice(1) : rawName;
  const argsText = typeof params.args === "string" ? params.args : "";
  if (name.length === 0) fail("command_run requires a command name");
  const resolved = resolveCommand(name, { templates: ctx.commands, pluginCommands: ctx.pluginCommands });
  if (resolved.kind === "unknown") {
    throw new AgencyError(ErrorCode.INTERNAL, unknownCommandMessage(name), { source: "command_run" });
  }
  if (resolved.kind === "builtin") {
    const fn = BUILTINS[resolved.name];
    if (!fn) fail(`command has no handler: ${resolved.name}`);
    const out = await fn(ctx, handlers, splitCommandArgs(argsText));
    return { name, kind: "builtin", ...out };
  }
  const template = resolved.kind === "template" ? resolved.template.content : resolved.command.template;
  const expanded = expandCommand(template, argsText, ctx.options.workspaceRoot, { shell: true });
  if (resolved.kind === "plugin") {
    return { name, kind: "plugin", text: expanded, pluginId: resolved.pluginId };
  }
  return { name, kind: "template", text: expanded, source: resolved.template.source };
}

export function registerCommandRunHandler(handlers: Record<string, MethodHandler>, ctx: DaemonContext): void {
  handlers.command_run = async (rawParams) => runCommand(ctx, handlers, rawParams);
}
