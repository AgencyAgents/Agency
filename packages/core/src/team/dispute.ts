import type { BoardStore } from "./todo.ts";

export interface ObjectionInput {
  itemId: string;
  by: string;
  evidence: string;
}

// Evidence is mandatory: a vague bounce with no specifics is
// refused at file time, never debated.
export function fileObjection(
  board: BoardStore,
  input: ObjectionInput,
): { ok: true } | { ok: false; reason: string } {
  if (input.evidence.trim().length === 0) return { ok: false, reason: "objection requires evidence" };
  return board.noteObjection(input.by, input.itemId, {
    by: input.by,
    evidence: input.evidence,
    round: "objection",
  });
}

// Exactly one rebuttal round; a second rebuttal routes to the
// tiebreaker instead of letting two agents argue forever.
export function fileRebuttal(
  board: BoardStore,
  input: ObjectionInput,
): { ok: true } | { ok: false; reason: string } {
  if (input.evidence.trim().length === 0) return { ok: false, reason: "rebuttal requires evidence" };
  const item = board.list().find((i) => i.id === input.itemId);
  if (!item) return { ok: false, reason: "not found" };
  const rebuttals = (item.objections ?? []).filter((o) => o.round === "rebuttal").length;
  if (rebuttals >= 1) return { ok: false, reason: "rebuttal round spent: route to tiebreak" };
  return board.noteObjection(input.by, input.itemId, {
    by: input.by,
    evidence: input.evidence,
    round: "rebuttal",
  });
}

export function needsTiebreak(board: BoardStore, itemId: string): boolean {
  const item = board.list().find((i) => i.id === itemId);
  if (!item || item.verdict) return false;
  const rounds = new Set((item.objections ?? []).map((o) => o.round));
  return rounds.has("objection") && rounds.has("rebuttal");
}

// Third provider wins: it must differ from both disputants, so a
// two-vendor argument is never settled by either vendor.
export function selectTiebreaker(opts: {
  authorProvider: string;
  reviewerProvider: string;
  availableProviders: readonly string[];
}): string | undefined {
  const a = opts.authorProvider.toLowerCase();
  const r = opts.reviewerProvider.toLowerCase();
  return opts.availableProviders.find((p) => {
    const low = p.toLowerCase();
    return low !== a && low !== r;
  });
}

export function recordTiebreak(
  board: BoardStore,
  opts: { itemId: string; by: string; winner: string; rationale: string; tiebreaker: string },
): { ok: true } | { ok: false; reason: string } {
  if (opts.rationale.trim().length === 0) return { ok: false, reason: "tiebreak requires a rationale" };
  return board.noteVerdict(opts.by, opts.itemId, {
    winner: opts.winner,
    tiebreaker: opts.tiebreaker,
    rationale: opts.rationale,
  });
}
