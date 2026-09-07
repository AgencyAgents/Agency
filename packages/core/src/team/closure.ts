import { buildTeamReport, type ReportOutcome, type TeamReport } from "./lateral.ts";
import type { BoardItem } from "./todo.ts";

/** Turns with zero board change before the run halts and surfaces. */
export const NO_PROGRESS_LIMIT = 5;

export type ProgressNote = "progress" | "waiting" | "stalled";

// Fingerprint skips needs-user items: waiting on a human is
// parked work, not evidence the team stopped making progress.
export function progressFingerprint(items: readonly BoardItem[]): string {
  const live = items
    .filter((i) => i.status !== "needs-user")
    .map((i) => `${i.id}:${i.status}:${i.claimedBy ?? ""}:${i.failureNote ?? ""}`)
    .sort();
  return live.join("|");
}

export function waitingOnUser(items: readonly BoardItem[]): boolean {
  const open = items.filter((i) => i.status === "pending" || i.status === "in_progress");
  if (open.length > 0) return false;
  return items.some((i) => i.status === "needs-user");
}

export class NoProgressTracker {
  private last = "";
  private still = 0;
  private started = false;

  constructor(private readonly limit: number = NO_PROGRESS_LIMIT) {}

  note(items: readonly BoardItem[]): ProgressNote {
    if (waitingOnUser(items)) {
      this.still = 0;
      return "waiting";
    }
    const hash = progressFingerprint(items);
    if (!this.started) {
      this.started = true;
      this.last = hash;
      return "progress";
    }
    if (hash !== this.last) {
      this.last = hash;
      this.still = 0;
      return "progress";
    }
    this.still += 1;
    return this.still >= this.limit ? "stalled" : "progress";
  }

  reset(): void {
    this.last = "";
    this.still = 0;
    this.started = false;
  }
}

export function checkCompletion(
  items: readonly BoardItem[],
  agentsIdle: boolean,
): { complete: boolean; outcome: ReportOutcome } {
  const open = items.some((i) => i.status === "pending" || i.status === "in_progress");
  if (open || !agentsIdle) return { complete: false, outcome: "halted" };
  if (items.some((i) => i.status === "needs-user")) return { complete: true, outcome: "needs-user" };
  return { complete: true, outcome: "complete" };
}

export function checkCaps(opts: {
  costUsd: number;
  wallMs: number;
  maxCostUsd?: number;
  maxWallMs?: number;
}): { ok: true } | { ok: false; outcome: ReportOutcome; reason: string } {
  if (opts.maxCostUsd !== undefined && opts.costUsd >= opts.maxCostUsd) {
    return {
      ok: false,
      outcome: "over-budget",
      reason: `cost cap exceeded: ${String(opts.costUsd)} >= ${String(opts.maxCostUsd)}`,
    };
  }
  if (opts.maxWallMs !== undefined && opts.wallMs >= opts.maxWallMs) {
    return { ok: false, outcome: "halted", reason: `wall-clock cap exceeded: ${String(opts.wallMs)}ms` };
  }
  return { ok: true };
}

// The single structured object crossing back to the lead: open
// questions are derived from escalate text, never retyped by hand.
export function completionReport(opts: {
  goal: string;
  outcome: ReportOutcome;
  items: readonly BoardItem[];
  decisions: Array<{ decision: string; proposedBy: string; rationale: string }>;
  cost: TeamReport["cost"];
  attempts: Record<string, { filesTouched: string[]; verification: string; byAgent: string }>;
}): TeamReport {
  const openQuestions = opts.items
    .filter((i) => i.status === "needs-user" && i.escalateQuestion)
    .map((i) => i.escalateQuestion as string);
  return buildTeamReport({ ...opts, openQuestions });
}
