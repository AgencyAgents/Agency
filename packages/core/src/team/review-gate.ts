import { scopeMatchesPattern } from "@agency/guard";
import type { BoardItem } from "./todo.ts";

export interface ReviewDiagnostic {
  path: string;
  severity: number;
  message: string;
  line: number;
  character: number;
}

/** LSP severity 1 is Error; warnings ride along but never block review. */
export const LSP_ERROR_SEVERITY = 1;

// New means present after the turn and absent before it, keyed on
// path plus line plus message, so pre-existing debt never blocks.
export function diffDiagnostics(
  before: readonly ReviewDiagnostic[],
  after: readonly ReviewDiagnostic[],
): ReviewDiagnostic[] {
  const key = (d: ReviewDiagnostic): string => `${d.path}|${String(d.line)}|${d.message}`;
  const seen = new Set(before.map(key));
  return after.filter((d) => !seen.has(key(d)));
}

function scopeCovers(scope: string, path: string): boolean {
  const rel = path.replace(/\\/g, "/");
  return scopeMatchesPattern(scope, rel);
}

// Board-level gate: an item with new error diagnostics in its own
// path scope is refused ready_for_review until the errors are fixed.
export function gateReadyForReview(opts: {
  item: BoardItem;
  diagnostics: readonly ReviewDiagnostic[];
}): string | undefined {
  const scopes = opts.item.pathScope ?? [];
  if (scopes.length === 0) return undefined;
  const blocking = opts.diagnostics.filter(
    (d) => d.severity === LSP_ERROR_SEVERITY && scopes.some((scope) => scopeCovers(scope, d.path)),
  );
  if (blocking.length === 0) return undefined;
  const first = blocking[0];
  return `refused ready_for_review: ${String(blocking.length)} new diagnostics in scope (${first?.path}:${String(first?.line)} ${first?.message ?? ""})`;
}
