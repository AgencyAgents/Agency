import type { BoardItem, BoardStore, FileItemRequest } from "./todo.ts";

export interface DelegateRequest {
  to?: string;
  needs?: string[];
  brief: string;
  acceptanceCriteria?: string;
  briefing?: string;
  pathScope?: string[];
  budgetUsd?: number;
  budgetTurns?: number;
  tools?: string[];
  parallelizable?: boolean;
}

// Registry facts the runtime already holds: capabilities, tool
// grants, relative price, and work currently in flight.
export interface AgentFacts {
  handle: string;
  capabilities: string[];
  tools: readonly string[] | "*";
  priceIndex: number;
  inFlight: number;
}

export type DelegateVerdict =
  | { delegate: true; handle: string; reason: string }
  | { delegate: false; reason: string };

function hasTools(facts: AgentFacts, tools: readonly string[] | undefined): boolean {
  if (tools === undefined || tools.length === 0) return true;
  if (facts.tools === "*") return true;
  return tools.every((tool) => facts.tools.includes(tool));
}

function hasNeeds(facts: AgentFacts, needs: readonly string[] | undefined): boolean {
  if (needs === undefined || needs.length === 0) return true;
  return needs.every((need) => facts.capabilities.includes(need));
}

function resolveTarget(req: DelegateRequest, candidates: readonly AgentFacts[]): AgentFacts | undefined {
  if (req.to !== undefined) return candidates.find((c) => c.handle === req.to);
  const needs = req.needs ?? [];
  const matching = candidates.filter((c) => hasNeeds(c, needs) && hasTools(c, req.tools));
  if (matching.length === 0) return undefined;
  return [...matching].sort((a, b) => {
    const needGap =
      needs.filter((n) => b.capabilities.includes(n)).length -
      needs.filter((n) => a.capabilities.includes(n)).length;
    if (needGap !== 0) return needGap;
    if (a.inFlight !== b.inFlight) return a.inFlight - b.inFlight;
    return a.priceIndex - b.priceIndex;
  })[0];
}

// The delegation check runs on registry facts, never model
// judgment: self-doable work stays inline unless parallel, flight,
// or materially cheaper routing says otherwise.
export function checkDelegation(
  requester: AgentFacts,
  req: DelegateRequest,
  candidates: readonly AgentFacts[],
  opts: { cheaperBy?: number } = {},
): DelegateVerdict {
  if (req.brief.trim().length === 0) return { delegate: false, reason: "brief is empty" };
  const target = resolveTarget(req, candidates);
  if (!target) return { delegate: false, reason: "no agent matches the request" };
  if (target.handle === requester.handle) {
    return { delegate: false, reason: "requester is the best match; do it inline" };
  }
  const selfCapable = hasNeeds(requester, req.needs) && hasTools(requester, req.tools);
  if (!selfCapable) {
    return { delegate: true, handle: target.handle, reason: "requester lacks capability or tool" };
  }
  if (req.parallelizable === true && requester.inFlight > 0) {
    return { delegate: true, handle: target.handle, reason: "parallel work while requester is busy" };
  }
  const margin = opts.cheaperBy ?? 0.2;
  if (target.priceIndex < requester.priceIndex * (1 - margin)) {
    return { delegate: true, handle: target.handle, reason: "specialist is materially cheaper" };
  }
  return { delegate: false, reason: "requester can do this itself; do it inline" };
}

export interface DelegateFiled {
  item: BoardItem;
  handle: string;
}

// A delegate message materializes a durable board item addressed
// to the resolved handle, recorded as a delegate board event.
export function materializeDelegate(
  board: BoardStore,
  filedBy: string,
  req: DelegateRequest,
  handle: string,
  grants?: { pathScope?: readonly string[] | "*"; tools?: readonly string[] | "*" },
): { ok: true; filed: DelegateFiled } | { ok: false; reason: string } {
  const fileReq: FileItemRequest = {
    content: req.brief,
    ...(req.acceptanceCriteria === undefined ? {} : { acceptanceCriteria: req.acceptanceCriteria }),
    ...(req.briefing === undefined ? {} : { briefing: req.briefing }),
    ...(req.pathScope === undefined ? {} : { pathScope: req.pathScope }),
    ...(req.budgetUsd === undefined ? {} : { budgetUsd: req.budgetUsd }),
    ...(req.budgetTurns === undefined ? {} : { budgetTurns: req.budgetTurns }),
    ...(req.tools === undefined ? {} : { tools: req.tools }),
  };
  const outcome = board.file(fileReq, filedBy, grants);
  if (!outcome.ok) return outcome;
  board.record(outcome.item.id, filedBy, `delegate:${handle}`, req.brief.slice(0, 200));
  return { ok: true, filed: { item: outcome.item, handle } };
}

export type ReportOutcome = "complete" | "halted" | "over-budget" | "needs-user";

export interface ReportItemEntry {
  item: string;
  filesTouched: string[];
  verification: string;
  byAgent: string;
  costUsd: number;
}

export interface ReportUnresolved {
  item: string;
  reason: string;
  lastAttemptBy: string;
}

export interface TeamReport {
  goal: string;
  outcome: ReportOutcome;
  itemsCompleted: ReportItemEntry[];
  itemsUnresolved: ReportUnresolved[];
  decisions: Array<{ decision: string; proposedBy: string; rationale: string }>;
  openQuestions: string[];
  cost: {
    totalUsd: number;
    perAgent: Record<string, number>;
    tokens: number;
    cacheHitRate: number;
    inputTokens: number;
    outputTokens: number;
    cachedInputTokens: number;
    cacheWriteInputTokens: number;
  };
}

// The report is the only object crossing back to the lead: goal,
// outcome, items, decisions, questions, cost. No transcripts cross.
export function buildTeamReport(args: {
  goal: string;
  outcome: ReportOutcome;
  items: readonly BoardItem[];
  decisions: Array<{ decision: string; proposedBy: string; rationale: string }>;
  openQuestions: string[];
  cost: TeamReport["cost"];
  attempts: Record<string, { filesTouched: string[]; verification: string; byAgent: string }>;
}): TeamReport {
  const completed: ReportItemEntry[] = [];
  const unresolved: ReportUnresolved[] = [];
  for (const item of args.items) {
    if (item.status === "completed" || item.status === "ready_for_review") {
      const attempt = args.attempts[item.id] ?? { filesTouched: [], verification: "", byAgent: "" };
      completed.push({
        item: item.id,
        filesTouched: attempt.filesTouched,
        verification: attempt.verification,
        byAgent: attempt.byAgent,
        costUsd: args.cost.perAgent[attempt.byAgent] ?? 0,
      });
    } else {
      unresolved.push({
        item: item.id,
        reason: item.failureNote ?? item.escalateQuestion ?? item.status,
        lastAttemptBy: item.claimedBy ?? item.filedBy ?? "",
      });
    }
  }
  return {
    goal: args.goal,
    outcome: args.outcome,
    itemsCompleted: completed,
    itemsUnresolved: unresolved,
    decisions: args.decisions,
    openQuestions: args.openQuestions,
    cost: args.cost,
  };
}

// Coordinator demotion: while a team is live the lead keeps
// coordination tools only; write, edit, and bash are withheld.
export const LEAD_WITHHELD_TOOLS: readonly string[] = ["write", "edit", "bash"];

export function isTeamLive(items: ReadonlyArray<{ status: string }>): boolean {
  return items.some((item) => item.status === "pending" || item.status === "in_progress");
}

export function demoteLeadTools(toolNames: readonly string[], teamLive: boolean): string[] {
  if (!teamLive) return [...toolNames];
  const withheld = new Set(LEAD_WITHHELD_TOOLS);
  return toolNames.filter((name) => !withheld.has(name));
}
