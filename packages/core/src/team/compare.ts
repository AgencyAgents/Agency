import type { BoardStore, FileItemRequest } from "./todo.ts";

// dispatch_compare re-expressed as a team mode: one shared board
// item that N agents compare-claim for side-by-side evaluation.
export function openCompareItem(
  board: BoardStore,
  opts: { prompt: string; handles: readonly string[]; filedBy: string; id?: string },
): { ok: true; itemId: string } | { ok: false; reason: string } {
  const req: FileItemRequest = {
    content: `compare: ${opts.prompt}`,
    briefing: `comparison across ${opts.handles.join(", ")}`,
  };
  if (opts.id !== undefined) req.id = opts.id;
  const filed = board.file(req, opts.filedBy);
  if (!filed.ok) return filed;
  return { ok: true, itemId: filed.item.id };
}

// Non-exclusive by design: every comparer records its attempt on
// the same item, unlike claim which locks the item to one agent.
export function compareClaim(
  board: BoardStore,
  handle: string,
  itemId: string,
): { ok: true } | { ok: false; reason: string } {
  return board.compareClaim(handle, itemId);
}

// The verdict lands on the board with the winning handle named,
// so the comparison is auditable after the run.
export function recordCompareVerdict(
  board: BoardStore,
  opts: { itemId: string; by: string; winner: string; rationale: string },
): { ok: true } | { ok: false; reason: string } {
  if (opts.rationale.trim().length === 0) return { ok: false, reason: "verdict requires a rationale" };
  return board.noteVerdict(opts.by, opts.itemId, {
    winner: opts.winner,
    tiebreaker: "compare",
    rationale: opts.rationale,
  });
}
