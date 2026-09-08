import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { announceHook, type BoardStore } from "@agency/core";
import { AgencyError, ErrorCode } from "@agency/schema";

// Per-task cost ledger: one JSONL line per completed turn, keyed by
// board task id. Daemon-colocated (not telemetry) because it keys on
// board ids and enforces board budgets; telemetry stays board-free.
export interface TaskTurnEntry {
  taskId: string;
  costUsd: number;
  tokens: number;
  inputTokens: number;
  outputTokens: number;
  model: string;
  handle: string;
  /** True when no pricing was available (ollama-style families); cost is 0 but tokens still accrue. */
  pricingMissing: boolean;
  at: number;
}

export interface TaskUsageTotals {
  turns: number;
  costUsd: number;
  tokens: number;
  inputTokens: number;
  outputTokens: number;
}

function zeroTotals(): TaskUsageTotals {
  return { turns: 0, costUsd: 0, tokens: 0, inputTokens: 0, outputTokens: 0 };
}

// Malformed counters never crash a turn: non-finite or negative values
// coerce to 0, and the caller still gets a recorded turn.
function cleanAmount(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function hasTaskEntryShape(raw: unknown): raw is TaskTurnEntry {
  if (typeof raw !== "object" || raw === null) return false;
  const r = raw as Record<string, unknown>;
  return (
    typeof r.taskId === "string" &&
    r.taskId.length > 0 &&
    typeof r.costUsd === "number" &&
    typeof r.tokens === "number"
  );
}

export interface TaskCaps {
  budgetUsd?: number;
  budgetTurns?: number;
}

export class TaskUsageTracker {
  private readonly turns = new Map<string, TaskTurnEntry[]>();
  private readonly file: string | undefined;
  private readonly now: () => number;
  private readonly onWarn: (message: string) => void;

  constructor(
    opts: { file?: string; sessionsDir?: string; now?: () => number; onWarn?: (message: string) => void } = {},
  ) {
    this.file = opts.file ?? (opts.sessionsDir ? join(opts.sessionsDir, "task-ledger.jsonl") : undefined);
    this.now = opts.now ?? Date.now;
    this.onWarn =
      opts.onWarn ??
      ((message) => {
        console.warn(`[task-ledger] ${message}`);
      });
    if (this.file && existsSync(this.file)) this.load();
  }

  // Records one turn under a task; returns null (warn, no throw) when
  // there is no task to attribute to, so persistence never breaks a turn.
  recordTurn(
    taskId: string,
    turn: {
      usage: { inputTokens: number; outputTokens: number };
      costUsd: number;
      model: string;
      handle: string;
      pricingMissing?: boolean;
    },
  ): TaskTurnEntry | null {
    if (taskId.length === 0) {
      this.onWarn("record skipped: empty taskId");
      return null;
    }
    const entry: TaskTurnEntry = {
      taskId,
      costUsd: cleanAmount(turn.costUsd),
      tokens: cleanAmount(turn.usage.inputTokens) + cleanAmount(turn.usage.outputTokens),
      inputTokens: cleanAmount(turn.usage.inputTokens),
      outputTokens: cleanAmount(turn.usage.outputTokens),
      model: turn.model,
      handle: turn.handle,
      pricingMissing: turn.pricingMissing ?? false,
      at: this.now(),
    };
    const list = this.turns.get(taskId) ?? [];
    list.push(entry);
    this.turns.set(taskId, list);
    this.append(entry);
    return entry;
  }

  totalsFor(taskId: string): TaskUsageTotals {
    const list = this.turns.get(taskId) ?? [];
    const totals = zeroTotals();
    totals.turns = list.length;
    for (const entry of list) {
      totals.costUsd += entry.costUsd;
      totals.tokens += entry.tokens;
      totals.inputTokens += entry.inputTokens;
      totals.outputTokens += entry.outputTokens;
    }
    return totals;
  }

  historyFor(taskId: string): TaskTurnEntry[] {
    return [...(this.turns.get(taskId) ?? [])];
  }

  perTask(): Record<string, { costUsd: number; tokens: number }> {
    const out: Record<string, { costUsd: number; tokens: number }> = {};
    for (const [taskId] of this.turns) {
      const totals = this.totalsFor(taskId);
      out[taskId] = { costUsd: totals.costUsd, tokens: totals.tokens };
    }
    return out;
  }

  check(
    taskId: string,
    caps: TaskCaps | undefined,
    estimateUsd = 0,
  ): { ok: true } | { ok: false; scope: "task-usd" | "task-turns"; reason: string } {
    const totals = this.totalsFor(taskId);
    if (caps?.budgetTurns !== undefined && totals.turns >= caps.budgetTurns) {
      return {
        ok: false,
        scope: "task-turns",
        reason: `task turn cap exceeded: task ${taskId} used ${totals.turns} turns of ${caps.budgetTurns} allowed`,
      };
    }
    if (caps?.budgetUsd !== undefined && totals.costUsd + estimateUsd > caps.budgetUsd) {
      return {
        ok: false,
        scope: "task-usd",
        reason: `task budget exceeded: task ${taskId} spent $${totals.costUsd.toFixed(4)} plus $${estimateUsd.toFixed(4)} estimate over $${caps.budgetUsd.toFixed(4)} cap`,
      };
    }
    return { ok: true };
  }

  private load(): void {
    let text: string;
    try {
      text = readFileSync(this.file as string, "utf8");
    } catch {
      return;
    }
    for (const [offset, line] of text.split("\n").entries()) {
      if (line.length === 0) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch (error) {
        this.onWarn(`corrupt ledger line ${offset + 1} skipped: ${error instanceof Error ? error.message : String(error)}`);
        continue;
      }
      if (!hasTaskEntryShape(parsed)) {
        this.onWarn(`ledger line ${offset + 1} skipped (shape mismatch)`);
        continue;
      }
      const entry: TaskTurnEntry = {
        taskId: parsed.taskId,
        costUsd: cleanAmount(parsed.costUsd),
        tokens: cleanAmount(parsed.tokens),
        inputTokens: cleanAmount(typeof parsed.inputTokens === "number" ? parsed.inputTokens : 0),
        outputTokens: cleanAmount(typeof parsed.outputTokens === "number" ? parsed.outputTokens : 0),
        model: typeof parsed.model === "string" ? parsed.model : "",
        handle: typeof parsed.handle === "string" ? parsed.handle : "",
        pricingMissing: parsed.pricingMissing === true,
        at: typeof parsed.at === "number" && Number.isFinite(parsed.at) ? parsed.at : this.now(),
      };
      const list = this.turns.get(entry.taskId) ?? [];
      list.push(entry);
      this.turns.set(entry.taskId, list);
    }
  }

  private append(entry: TaskTurnEntry): void {
    if (!this.file) return;
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      appendFileSync(this.file, `${JSON.stringify(entry)}\n`, "utf8");
    } catch (error) {
      this.onWarn(`append failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

// Claim resolution shared by the record and preflight paths: an explicit
// taskId wins, otherwise the handle's claimed board item.
export function resolveTaskId(args: {
  board?: BoardStore;
  handle?: string;
  taskId?: string;
}): string | undefined {
  if (args.taskId !== undefined && args.taskId.length > 0) return args.taskId;
  if (args.board && args.handle) {
    return args.board.list().find((item) => item.claimedBy === args.handle)?.id;
  }
  return undefined;
}

// Pre-provider-call gate mirroring assertPreflightCaps: a breached
// per-task cap throws typed before any provider invocation.
export function assertTaskPreflightCaps(args: {
  board: BoardStore;
  ledger?: TaskUsageTracker;
  handle?: string;
  taskId?: string;
  estimateUsd?: number;
  announce?: { bus: { emit(event: string, payload: unknown): void }; sessionId: string };
}): void {
  if (!args.ledger) return;
  const taskId = resolveTaskId({ board: args.board, handle: args.handle, taskId: args.taskId });
  if (!taskId) return;
  const item = args.board.list().find((entry) => entry.id === taskId);
  if (!item) return;
  if (item.budgetUsd === undefined && item.budgetTurns === undefined) return;
  const gate = args.ledger.check(
    taskId,
    {
      ...(item.budgetUsd === undefined ? {} : { budgetUsd: item.budgetUsd }),
      ...(item.budgetTurns === undefined ? {} : { budgetTurns: item.budgetTurns }),
    },
    args.estimateUsd ?? 0,
  );
  if (!gate.ok) {
    if (args.announce !== undefined) {
      announceHook(args.announce.bus, "cost.threshold", { reason: gate.reason, sessionId: args.announce.sessionId });
    }
    throw new AgencyError(ErrorCode.PERMISSION_DENIED, gate.reason, { source: "spend" });
  }
}
