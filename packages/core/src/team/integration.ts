import type { BoardStore } from "./todo.ts";

export interface MergeTarget {
  itemId: string;
  path: string;
  branch: string;
}

export interface IntegrationOutcome {
  merged: string[];
  returned: Array<{ itemId: string; conflict: string }>;
}

export async function integrateSequentially(opts: {
  board: BoardStore;
  leadHandle: string;
  callerHandle: string;
  targets: readonly MergeTarget[];
  merge: (target: MergeTarget) => Promise<{ ok: true } | { ok: false; conflict: string }>;
}): Promise<IntegrationOutcome> {
  if (opts.callerHandle !== opts.leadHandle) {
    throw new Error(`integration is lead-owned: ${opts.callerHandle} is not the lead`);
  }
  const merged: string[] = [];
  const returned: Array<{ itemId: string; conflict: string }> = [];
  for (const target of opts.targets) {
    const outcome = await opts.merge(target);
    if (outcome.ok) {
      opts.board.setStatus(opts.leadHandle, target.itemId, "completed");
      merged.push(target.itemId);
    } else {
      opts.board.failToPending(opts.leadHandle, target.itemId, `merge conflict: ${outcome.conflict}`);
      returned.push({ itemId: target.itemId, conflict: outcome.conflict });
    }
  }
  return { merged, returned };
}
