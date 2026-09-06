import { getSessionTitle, loadTraceSpansSync, restoreIntegrationCheckpoint } from "@agency/core";
import type { MethodHandler } from "@agency/rpc";
import type { Message } from "@agency/schema";
import { AgencyError, ErrorCode } from "@agency/schema";
import { isUsageEntry } from "@agency/telemetry";
import { TEAM_MCP_PROCESS_CAP } from "@agency/tools";
import { agentsListPayload } from "../team-context.ts";
import {
  type DaemonContext,
  DEFAULT_SYSTEM_PROMPT,
  type RunTurnParams,
  resolvePrompt,
  type SystemPromptParts,
} from "../types.ts";

/** Keys config_set may change at runtime (in-memory until restart). */
const RUNTIME_CONFIG_KEYS = [
  "logLevel",
  "locale",
  "telemetryEnabled",
  "crashReportsEnabled",
  "model",
  "small_model",
  "theme",
];

function requireSessionId(rawParams: unknown, method: string): string {
  const { sessionId } = rawParams as { sessionId?: string };
  if (!sessionId)
    throw new AgencyError(ErrorCode.INTERNAL, `${method} requires sessionId`, { source: "surface" });
  return sessionId;
}

export function registerSurfaceHandlers(handlers: Record<string, MethodHandler>, ctx: DaemonContext): void {
  const {
    config,
    defaultCapabilitiesForSession,
    listModels,
    sessionScopes,
    teamCheckpoints,
    teamMcpPools,
    todoSessionsDir,
    todoStore,
    turnCheckpoints,
  } = ctx;

  handlers.session_list = async () => {
    const sessions = todoStore.list().map((id) => {
      const entries = todoStore.load(id);
      const last = entries[entries.length - 1];
      return {
        id,
        title: getSessionTitle(entries),
        tipId: todoStore.latestTip(entries) ?? last?.id ?? null,
        entries: entries.length,
        updatedAt: last?.createdAt ?? null,
      };
    });
    return { sessions };
  };

  handlers.session_create = async (rawParams) => {
    const { sessionId } = (rawParams ?? {}) as { sessionId?: string };
    const meta =
      typeof sessionId === "string" && sessionId.length > 0
        ? todoStore.create(sessionId)
        : todoStore.create();
    return { sessionId: meta.id };
  };

  handlers.session_export = async (rawParams) => {
    const sessionId = requireSessionId(rawParams, "session_export");
    const entries = todoStore.export(sessionId);
    if (entries.length === 0)
      throw new AgencyError(ErrorCode.INTERNAL, `unknown session: ${sessionId}`, { source: "surface" });
    return { sessionId, entries };
  };

  handlers.session_rename = async (rawParams) => {
    const sessionId = requireSessionId(rawParams, "session_rename");
    if (todoStore.load(sessionId).length === 0)
      throw new AgencyError(ErrorCode.INTERNAL, `unknown session: ${sessionId}`, { source: "surface" });
    const { newSessionId } = (rawParams ?? {}) as { newSessionId?: string };
    const target = typeof newSessionId === "string" && newSessionId.length > 0 ? newSessionId : undefined;
    if (target !== undefined && todoStore.load(target).length > 0)
      throw new AgencyError(ErrorCode.INTERNAL, `session already exists: ${target}`, { source: "surface" });
    const meta = todoStore.clone(sessionId, target);
    todoStore.delete(sessionId);
    const stack = turnCheckpoints.get(sessionId);
    turnCheckpoints.delete(sessionId);
    if (stack) turnCheckpoints.set(meta.id, stack);
    return { sessionId: meta.id, renamedFrom: sessionId };
  };

  handlers.models_list = async (rawParams) => {
    const { provider } = (rawParams ?? {}) as { provider?: string };
    const models = listModels()
      .filter((m) => provider === undefined || m.family === provider)
      .map((m) => ({
        id: m.id,
        family: m.family,
        name: m.name,
        providerName: m.providerName,
        contextWindow: m.contextWindow,
        maxOutputTokens: m.maxOutputTokens,
        pricing: m.pricing,
        capabilities: m.capabilities,
        status: m.status,
        releaseDate: m.releaseDate,
      }));
    return { models };
  };

  handlers.config_get = async (rawParams) => {
    const redacted = redactConfig(config as unknown as Record<string, unknown>);
    const { key } = (rawParams ?? {}) as { key?: string };
    if (key === undefined) return { config: redacted };
    if (!(key in redacted))
      throw new AgencyError(ErrorCode.INTERNAL, `unknown config key: ${key}`, { source: "surface" });
    return { key, value: redacted[key] };
  };

  handlers.config_set = async (rawParams) => {
    const { key, value } = (rawParams ?? {}) as { key?: string; value?: unknown };
    if (typeof key !== "string" || !RUNTIME_CONFIG_KEYS.includes(key))
      throw new AgencyError(
        ErrorCode.INTERNAL,
        `config_set allows only ${RUNTIME_CONFIG_KEYS.join(", ")} (in-memory until restart)`,
        { source: "surface" },
      );
    if (value === undefined)
      throw new AgencyError(ErrorCode.INTERNAL, "config_set requires value", { source: "surface" });
    checkRuntimeValue(key, value);
    (config as unknown as Record<string, unknown>)[key] = value;
    return { key, value };
  };

  handlers.permissions_list = async (rawParams) => {
    const { sessionId } = (rawParams ?? {}) as { sessionId?: string };
    const capabilities = await defaultCapabilitiesForSession(sessionId);
    return { permissions: config.permissions, capabilities };
  };

  handlers.todo_read = async (rawParams) => {
    const sessionId = requireSessionId(rawParams, "todo_read");
    return { sessionId, todos: readTodos(todoStore.load(sessionId)) ?? [] };
  };

  handlers.todo_write = async (rawParams) => {
    const sessionId = requireSessionId(rawParams, "todo_write");
    const { todos } = (rawParams ?? {}) as { todos?: unknown };
    const checked = checkTodos(todos);
    const entries = todoStore.load(sessionId);
    const appended = await todoStore.append(sessionId, {
      type: "todo_state",
      parentId: todoStore.latestTip(entries) ?? null,
      todos: checked,
    });
    return { sessionId, written: checked.length, tipId: appended.id };
  };

  handlers.cost_report = async (rawParams) => {
    const { sessionId } = (rawParams ?? {}) as { sessionId?: string };
    const ids = sessionId !== undefined ? [sessionId] : todoStore.list();
    const sessions = ids.map((id) => costForSession(todoStore.load(id), todoSessionsDir, id));
    const total = sessions.reduce(
      (acc, s) => ({
        turns: acc.turns + s.turns,
        inputTokens: acc.inputTokens + s.inputTokens,
        outputTokens: acc.outputTokens + s.outputTokens,
        costUsd: acc.costUsd + s.costUsd,
      }),
      { turns: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 },
    );
    let sharedServers = 0;
    for (const pool of teamMcpPools.values()) sharedServers += pool.usage().sharedServers;
    const mcp = {
      sharedServers,
      perAgentScopes: sessionScopes.size,
      cap: TEAM_MCP_PROCESS_CAP,
    };
    return { sessions, agents: agentsListPayload(ctx, sessionId), total, mcp };
  };

  handlers.undo_run = async (rawParams) => {
    const sessionId = requireSessionId(rawParams, "undo_run");
    const tip = turnCheckpoints.get(sessionId)?.pop();
    if (tip !== undefined) {
      try {
        await todoStore.rollback(sessionId, tip);
      } catch (error) {
        throw new AgencyError(
          ErrorCode.INTERNAL,
          `undo_run failed: ${error instanceof Error ? error.message : String(error)}`,
          { source: "surface" },
        );
      }
      return { undone: true, sessionId, tipId: tip, scope: "session" };
    }
    const checkpoint = teamCheckpoints.get(sessionId);
    if (checkpoint === undefined) {
      return { undone: false, reason: "no checkpoint: session_send records one per turn" };
    }
    const { restored } = restoreIntegrationCheckpoint(checkpoint);
    teamCheckpoints.delete(sessionId);
    return { undone: true, sessionId, scope: "team", restored: restored.length };
  };

  handlers.prompt_inspect = async (rawParams) => {
    const p = (rawParams ?? {}) as {
      systemPrompt?: string;
      systemPromptParts?: SystemPromptParts;
      session?: Message[];
    };
    const params: RunTurnParams = {
      turnId: "inspect",
      provider: "inspect",
      model: "inspect",
      systemPrompt: p.systemPrompt ?? DEFAULT_SYSTEM_PROMPT,
      session: p.session ?? [],
      ...(p.systemPromptParts === undefined ? {} : { systemPromptParts: p.systemPromptParts }),
    };
    const resolved = resolvePrompt(params, { workspaceRoot: ctx.options.workspaceRoot });
    return { prompt: resolved.text, segments: resolved.segments };
  };
}

function redactConfig(config: Record<string, unknown>): Record<string, unknown> {
  const providers = config.provider;
  if (!providers || typeof providers !== "object" || Array.isArray(providers)) return { ...config };
  const redactedProviders: Record<string, unknown> = {};
  for (const [id, pc] of Object.entries(providers as Record<string, unknown>)) {
    if (pc && typeof pc === "object" && !Array.isArray(pc) && "apiKey" in (pc as Record<string, unknown>)) {
      redactedProviders[id] = { ...(pc as Record<string, unknown>), apiKey: "***" };
    } else {
      redactedProviders[id] = pc;
    }
  }
  return { ...config, provider: redactedProviders };
}

function checkRuntimeValue(key: string, value: unknown): void {
  const fail = (): never => {
    throw new AgencyError(ErrorCode.INTERNAL, `config_set: invalid value for ${key}`, { source: "surface" });
  };
  if (key === "logLevel") {
    if (value !== "debug" && value !== "info" && value !== "warn" && value !== "error") fail();
  } else if (key === "telemetryEnabled" || key === "crashReportsEnabled") {
    if (typeof value !== "boolean") fail();
  } else if (typeof value !== "string") fail();
}

const TODO_STATUSES = ["pending", "in_progress", "completed", "ready_for_review"];

function checkTodos(todos: unknown): { id: string; content: string; status: string }[] {
  if (!Array.isArray(todos))
    throw new AgencyError(ErrorCode.INTERNAL, "todo_write requires todos array", { source: "surface" });
  return todos.map((t) => {
    const item = t as { id?: unknown; content?: unknown; status?: unknown };
    if (typeof item?.id !== "string" || typeof item?.content !== "string" || typeof item?.status !== "string")
      throw new AgencyError(ErrorCode.INTERNAL, "todo_write: each todo needs string id, content, status", {
        source: "surface",
      });
    if (!TODO_STATUSES.includes(item.status))
      throw new AgencyError(ErrorCode.INTERNAL, `todo_write: unknown status ${item.status}`, {
        source: "surface",
      });
    return { id: item.id, content: item.content, status: item.status };
  });
}

function readTodos(
  entries: { type: string }[],
): { id: string; content: string; status: string }[] | undefined {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i] as { type: string; todos?: unknown };
    if (entry?.type === "todo_state" && Array.isArray(entry.todos)) {
      return entry.todos as { id: string; content: string; status: string }[];
    }
  }
  return undefined;
}

function costForSession(
  entries: { type: string }[],
  sessionsDir: string,
  sessionId: string,
): {
  sessionId: string;
  turns: number;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  costUsd: number;
  traceModelSpans: number;
  traceCostUsd: number;
} {
  let turns = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let cachedInputTokens = 0;
  let costUsd = 0;
  for (const entry of entries) {
    if (!isUsageEntry(entry)) continue;
    const record = entry as unknown as {
      usage: { inputTokens: number; outputTokens: number; cachedInputTokens?: number };
    };
    turns += 1;
    inputTokens += record.usage.inputTokens;
    outputTokens += record.usage.outputTokens;
    cachedInputTokens += record.usage.cachedInputTokens ?? 0;
    costUsd += (entry as unknown as { costUsd: number }).costUsd;
  }
  let traceModelSpans = 0;
  let traceCostUsd = 0;
  try {
    for (const span of loadTraceSpansSync(sessionsDir, sessionId)) {
      if (span.kind !== "model") continue;
      traceModelSpans += 1;
      traceCostUsd += span.attributes.cost ?? 0;
    }
  } catch {
    // Trace files are best-effort; usage entries carry the totals.
  }
  return {
    sessionId,
    turns,
    inputTokens,
    outputTokens,
    cachedInputTokens,
    costUsd,
    traceModelSpans,
    traceCostUsd,
  };
}
