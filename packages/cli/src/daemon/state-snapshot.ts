import { projectSessionView } from "@agency/core";
import { agentsListPayload } from "./team-context.ts";
import type { DaemonContext } from "./types.ts";

/** Connect-time `state` frame: live turns, approvals, agents, and cost. */
export function buildStateSnapshot(ctx: DaemonContext, sessionId?: string): Record<string, unknown> {
  const turns = [...ctx.activeTurnMeta.entries()].map(([turnId, meta]) => ({
    turnId,
    sessionId: meta.sessionId,
    provider: meta.provider,
    model: meta.model,
  }));
  const approvals = [...ctx.approvalManagers.entries()].flatMap(([sid, manager]) =>
    manager.listPending().map((p) => ({ sessionId: sid, ...p })),
  );
  let totalUsd = 0;
  const bySession: Record<string, number> = {};
  for (const team of ctx.teamContexts.values()) {
    totalUsd += team.teamTotal.value;
    for (const [sid, cost] of team.teamCost) bySession[sid] = (bySession[sid] ?? 0) + cost;
  }
  const snapshot: Record<string, unknown> = {
    turns,
    approvals,
    agents: agentsListPayload(ctx, sessionId),
    cost: { totalUsd, bySession },
  };
  if (sessionId !== undefined) snapshot.session = projectSessionView(ctx.todoStore, sessionId);
  return snapshot;
}

/** Ring key for an event: sessions group, turns resolve via live metadata. */
export function sessionKeyForEvent(ctx: DaemonContext, event: string): string | undefined {
  if (event.startsWith("session.")) return event.slice("session.".length);
  if (event.startsWith("turn.")) {
    return ctx.activeTurnMeta.get(event.slice("turn.".length))?.sessionId;
  }
  return undefined;
}
