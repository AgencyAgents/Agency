import type { BoardItem, BoardStore } from "./todo.ts";

export interface OrphanWorktree {
  path: string;
  branch: string;
  hasUncommitted: boolean;
}

export interface RecoverySummary {
  reloaded: number;
  released: string[];
  orphans: string[];
}

export function recoverTeamBoard(opts: {
  board: BoardStore;
  persisted: BoardItem[];
  liveTurn: (claimedBy: string) => boolean;
  worktrees: OrphanWorktree[];
  filedBy?: string;
}): RecoverySummary {
  const { board, persisted, liveTurn, worktrees } = opts;
  const filedBy = opts.filedBy ?? "lead";
  board.hydrate(persisted);
  const released: string[] = [];
  for (const item of board.list()) {
    if (item.claimedBy !== undefined && !liveTurn(item.claimedBy)) {
      const by = item.claimedBy;
      board.failToPending("recovery", item.id, `claim by ${by} released: no live turn after restart`);
      released.push(item.id);
    }
  }
  const orphans: string[] = [];
  for (const worktree of worktrees) {
    if (!worktree.hasUncommitted) continue;
    const filed = board.file(
      {
        id: `orphan-${orphans.length + 1}`,
        content: `reconcile orphaned worktree at ${worktree.path} (${worktree.branch})`,
        briefing: "uncommitted work survived a daemon restart; decide to integrate or discard",
      },
      filedBy,
    );
    if (filed.ok) {
      board.setStatus(filedBy, filed.item.id, "needs-user");
      orphans.push(filed.item.id);
    }
  }
  return { reloaded: board.list().length, released, orphans };
}
