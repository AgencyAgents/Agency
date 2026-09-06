import { join } from "node:path";
import { loadTraceSpansSync } from "@agency/core";
import { AgencyError, ErrorCode, type Message } from "@agency/schema";
import type { DaemonContext } from "./types.ts";

export type ChildState = "idle" | "working" | "blocked" | "failed";

export interface ChildSessionMeta {
  handle: string;
  batchId: number;
  childKey: string;
}

/**
 * Per-parent-session team state. Every dispatched child is keyed by
 * `${parentSessionId}:${handle}:${batchId}`, so two parents dispatching
 * the same handle never share a session file, inbox, or cost counter.
 */
export interface TeamContext {
  parentSessionId: string;
  agentStates: Map<string, ChildState>;
  agentInboxes: Map<string, Message[]>;
  teamCost: Map<string, number>;
  teamTotal: { value: number };
  sessions: Map<string, ChildSessionMeta>;
  nextBatchId: number;
}

export function createTeamContext(parentSessionId: string): TeamContext {
  return {
    parentSessionId,
    agentStates: new Map(),
    agentInboxes: new Map(),
    teamCost: new Map(),
    teamTotal: { value: 0 },
    sessions: new Map(),
    nextBatchId: 0,
  };
}

/** Canonical child key: parent session, handle, and dispatch batch. */
export function childKey(parentSessionId: string, handle: string, batchId: number): string {
  return `${parentSessionId}:${handle}:${batchId}`;
}

/** File-safe segment: anything outside [A-Za-z0-9-_] becomes a dash. */
export function sanitizeSegment(value: string): string {
  const clean = value.replace(/[^A-Za-z0-9-_]+/g, "-").replace(/^-+|-+$/g, "");
  return clean.length > 0 ? clean : "session";
}

/** Child session id derived from the child key, distinct per parent. */
export function childSessionIdFor(parentSessionId: string, handle: string, batchId: number): string {
  return `team-${sanitizeSegment(parentSessionId)}-${sanitizeSegment(handle)}-b${batchId}`;
}

/** Worktree root for a parent's peer, namespaced so parents never share. */
export function worktreePathFor(workspaceRoot: string, parentSessionId: string, handle: string): string {
  return join(
    workspaceRoot,
    ".agency",
    "worktrees",
    sanitizeSegment(parentSessionId),
    sanitizeSegment(handle),
  );
}

/** Unique branch per child: same basename would collide across parents. */
export function worktreeBranchFor(parentSessionId: string, handle: string, batchId: number): string {
  return `agency/${sanitizeSegment(parentSessionId)}/${sanitizeSegment(handle)}-b${batchId}`;
}

/**
 * Typed abort for a peer whose worktree failed: the dispatch path must
 * fail closed on this, never fall back to the workspace root.
 */
export function worktreeError(handle: string, path: string, cause: unknown): AgencyError {
  const detail = cause instanceof Error ? cause.message : String(cause);
  return new AgencyError(
    ErrorCode.TOOL_ERROR,
    `worktree creation failed for ${handle} at ${path}: ${detail}`,
    {
      source: "dispatch",
      cause,
      context: { reason: "worktree-create-failed", worktree: path },
    },
  );
}

/** Latest child session id for a handle inside one parent context. */
export function latestChildSession(team: TeamContext, handle: string): string | undefined {
  let best: string | undefined;
  let bestBatch = -1;
  for (const [sid, meta] of team.sessions) {
    if (meta.handle === handle && meta.batchId > bestBatch) {
      best = sid;
      bestBatch = meta.batchId;
    }
  }
  return best;
}

/** Drain every box for a handle inside one parent, oldest batch first. */
export function drainParentInbox(team: TeamContext, handle: string): Message[] {
  const out: Message[] = [];
  const ordered = [...team.sessions.entries()].sort((a, b) => a[1].batchId - b[1].batchId);
  for (const [, meta] of ordered) {
    if (meta.handle !== handle) continue;
    const box = team.agentInboxes.get(meta.childKey);
    if (box && box.length > 0) {
      out.push(...box);
      box.length = 0;
    }
  }
  return out;
}

/** Latest child session for a handle across every parent context. */
export function latestChildAnywhere(ctx: DaemonContext, handle: string): string | undefined {
  let best: string | undefined;
  let bestBatch = -1;
  for (const team of ctx.teamContexts.values()) {
    const sid = latestChildSession(team, handle);
    const meta = sid ? team.sessions.get(sid) : undefined;
    if (sid && meta && meta.batchId >= bestBatch) {
      best = sid;
      bestBatch = meta.batchId;
    }
  }
  return best;
}

/** Reverse lookup: which parent and handle own a child session id. */
export function findChildSession(
  ctx: DaemonContext,
  sessionId: string,
): { parentSessionId: string; handle: string; batchId: number; childKey: string } | undefined {
  for (const team of ctx.teamContexts.values()) {
    const meta = team.sessions.get(sessionId);
    if (meta) return { parentSessionId: team.parentSessionId, ...meta };
  }
  return undefined;
}

/**
 * Resolve a session id to its owning handle: a dispatched child first,
 * then the registry template (`team-<handle>`), so legacy callers that
 * address the template keep working after isolation.
 */
export function handleForSession(ctx: DaemonContext, sessionId: string): string | undefined {
  const child = findChildSession(ctx, sessionId);
  if (child) return child.handle;
  return ctx.teamRegistry.list().find((a) => a.sessionId === sessionId)?.handle;
}

function traceCostFor(sessionsDir: string, sessionId: string): number {
  try {
    const spans = loadTraceSpansSync(sessionsDir, sessionId);
    return spans.filter((s) => s.kind === "model").reduce((sum, s) => sum + (s.attributes.cost ?? 0), 0);
  } catch {
    return 0;
  }
}

function recordedCostFor(ctx: DaemonContext, sessionId: string): number {
  let best = 0;
  for (const team of ctx.teamContexts.values()) {
    best = Math.max(best, team.teamCost.get(sessionId) ?? 0);
  }
  return best;
}

/**
 * USD spent for a handle: summed per child session as max(traced,
 * recorded), so one session's accounting matches the old global shape
 * while parents stay independent. Without a parent it aggregates the
 * registry template plus every parent context.
 */
export function costUsdForHandle(ctx: DaemonContext, handle: string, parentSessionId?: string): number {
  const sids: string[] = [];
  if (parentSessionId !== undefined) {
    const team = ctx.teamContexts.get(parentSessionId);
    if (team) {
      for (const [sid, meta] of team.sessions) {
        if (meta.handle === handle) sids.push(sid);
      }
    }
  } else {
    const agent = ctx.teamRegistry.get(handle);
    if (agent) sids.push(agent.sessionId);
    for (const team of ctx.teamContexts.values()) {
      for (const [sid, meta] of team.sessions) {
        if (meta.handle === handle) sids.push(sid);
      }
    }
  }
  let total = 0;
  for (const sid of sids) {
    total += Math.max(traceCostFor(ctx.todoSessionsDir, sid), recordedCostFor(ctx, sid));
  }
  return total;
}

export interface AgentRow {
  handle: string;
  role: string;
  provider: string;
  model: string;
  effort: string;
  state: string;
  sessionId: string;
  costUsd: number;
}

function rowState(team: TeamContext | undefined, handle: string): { state: string; sessionId?: string } {
  if (!team) return { state: "idle" };
  const sid = latestChildSession(team, handle);
  if (!sid) return { state: "idle" };
  const meta = team.sessions.get(sid);
  return { state: team.agentStates.get(meta?.childKey ?? "") ?? "idle", sessionId: sid };
}

/**
 * Agent rows for one parent, or aggregated across all parents when no
 * parent is given. Aggregation prefers any working state, then failed,
 * so a live peer is never hidden behind an idle sibling context.
 */
export function agentsListPayload(ctx: DaemonContext, parentSessionId?: string): AgentRow[] {
  return ctx.teamRegistry.list().map((a) => {
    if (parentSessionId !== undefined) {
      const team = ctx.teamContexts.get(parentSessionId);
      const scoped = rowState(team, a.handle);
      return {
        handle: a.handle,
        role: a.role,
        provider: a.provider,
        model: a.model ?? "",
        effort: a.effort,
        state: scoped.state,
        sessionId: scoped.sessionId ?? a.sessionId,
        costUsd: costUsdForHandle(ctx, a.handle, parentSessionId),
      };
    }
    let state = "idle";
    let sessionId = a.sessionId;
    const candidates: Array<{ state: string; sessionId: string; batch: number }> = [];
    for (const team of ctx.teamContexts.values()) {
      const sid = latestChildSession(team, a.handle);
      if (!sid) continue;
      const meta = team.sessions.get(sid);
      candidates.push({
        state: team.agentStates.get(meta?.childKey ?? "") ?? "idle",
        sessionId: sid,
        batch: meta?.batchId ?? 0,
      });
    }
    // A live or failed peer stays visible: working wins, then failed,
    // then the highest batch. Idle is only the no-children default.
    const working = candidates.find((c) => c.state === "working");
    const failed = candidates.find((c) => c.state === "failed");
    if (working) {
      state = "working";
      sessionId = working.sessionId;
    } else if (failed) {
      state = "failed";
      sessionId = failed.sessionId;
    } else if (candidates.length > 0) {
      const latest = candidates.reduce((x, y) => (y.batch >= x.batch ? y : x));
      state = latest.state;
      sessionId = latest.sessionId;
    }
    return {
      handle: a.handle,
      role: a.role,
      provider: a.provider,
      model: a.model ?? "",
      effort: a.effort,
      state,
      sessionId,
      costUsd: costUsdForHandle(ctx, a.handle),
    };
  });
}
