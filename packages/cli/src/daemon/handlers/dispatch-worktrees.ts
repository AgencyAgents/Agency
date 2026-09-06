import { listWorktrees, type PromiseBarrier, type SessionStore } from "@agency/core";
import type { TeamContext } from "../team-context.ts";
import { worktreeError } from "../team-context.ts";

export interface WorktreePeerDeps {
  team: TeamContext;
  todoStore: SessionStore;
  warnPersistence: (action: string, error: unknown) => void;
  broadcast: (event: string, payload: unknown) => void;
  barrier: PromiseBarrier<string>;
}

export async function isOwnWorktree(workspaceRoot: string, wtPath: string): Promise<boolean> {
  try {
    const listed = await listWorktrees(workspaceRoot);
    const norm = (p: string): string =>
      process.platform === "win32" ? p.replace(/\//g, "\\").toLowerCase() : p;
    return listed.some((w) => norm(w.path) === norm(wtPath));
  } catch {
    return false;
  }
}

export async function abortWorktreePeer(
  deps: WorktreePeerDeps,
  params: {
    slot: number;
    key: string;
    childSessionId: string;
    handle: string;
    wtPath: string;
    cause: unknown;
  },
): Promise<void> {
  const failure = worktreeError(params.handle, params.wtPath, params.cause);
  deps.team.agentStates.set(params.key, "failed");
  try {
    const tip = deps.todoStore.latestTip(deps.todoStore.load(params.childSessionId)) ?? null;
    await deps.todoStore
      .append(params.childSessionId, {
        type: "agent_lifecycle",
        parentId: tip,
        handle: params.handle,
        state: "failed",
        detail: failure.message,
      })
      .catch((appendError: unknown) => {
        deps.warnPersistence("agent_lifecycle append", appendError);
      });
  } catch (loadError: unknown) {
    deps.warnPersistence("agent_lifecycle load", loadError);
  }
  try {
    deps.broadcast(`team.${params.childSessionId}`, {
      type: "agent_lifecycle",
      handle: params.handle,
      state: "failed",
      detail: failure.message,
    });
  } catch {}
  try {
    deps.broadcast(`team.shared`, {
      type: "agent_lifecycle",
      handle: params.handle,
      state: "failed",
      detail: failure.message,
    });
  } catch {}
  deps.barrier.complete(params.slot, `${params.handle}: ${failure.message}`);
}
