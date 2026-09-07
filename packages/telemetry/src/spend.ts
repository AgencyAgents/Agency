import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export interface SpendCaps {
  dailyUsd?: number;
  monthlyUsd?: number;
}

function dayKey(at: number): string {
  return new Date(at).toISOString().slice(0, 10);
}

function monthKey(at: number): string {
  return new Date(at).toISOString().slice(0, 7);
}

export interface SpendSnapshot {
  day: string;
  dayTotalUsd: number;
  month: string;
  monthTotalUsd: number;
}

export class SpendLedger {
  private readonly days = new Map<string, number>();
  private readonly months = new Map<string, number>();
  private readonly now: () => number;
  private readonly file: string | undefined;

  constructor(opts: { now?: () => number; file?: string; sessionsDir?: string } = {}) {
    this.now = opts.now ?? Date.now;
    this.file = opts.file ?? (opts.sessionsDir ? join(opts.sessionsDir, "spend-ledger.json") : undefined);
    if (this.file && existsSync(this.file)) this.load();
  }

  record(costUsd: number, at: number = this.now()): SpendSnapshot {
    if (costUsd > 0) {
      const day = dayKey(at);
      const month = monthKey(at);
      this.days.set(day, (this.days.get(day) ?? 0) + costUsd);
      this.months.set(month, (this.months.get(month) ?? 0) + costUsd);
      this.save();
    }
    return this.snapshot(at);
  }

  dayTotal(at: number = this.now()): number {
    return this.days.get(dayKey(at)) ?? 0;
  }

  monthTotal(at: number = this.now()): number {
    return this.months.get(monthKey(at)) ?? 0;
  }

  snapshot(at: number = this.now()): SpendSnapshot {
    const day = dayKey(at);
    const month = monthKey(at);
    return {
      day,
      dayTotalUsd: this.days.get(day) ?? 0,
      month,
      monthTotalUsd: this.months.get(month) ?? 0,
    };
  }

  check(
    caps: SpendCaps | undefined,
    estimateUsd: number,
    at: number = this.now(),
  ): { ok: true } | { ok: false; scope: "daily" | "monthly"; reason: string } {
    const daily = caps?.dailyUsd;
    if (daily !== undefined && this.dayTotal(at) + estimateUsd > daily) {
      return {
        ok: false,
        scope: "daily",
        reason: `daily cap exceeded: spent $${this.dayTotal(at).toFixed(4)} plus $${estimateUsd.toFixed(4)} estimate over $${daily.toFixed(4)} cap`,
      };
    }
    const monthly = caps?.monthlyUsd;
    if (monthly !== undefined && this.monthTotal(at) + estimateUsd > monthly) {
      return {
        ok: false,
        scope: "monthly",
        reason: `monthly cap exceeded: spent $${this.monthTotal(at).toFixed(4)} plus $${estimateUsd.toFixed(4)} estimate over $${monthly.toFixed(4)} cap`,
      };
    }
    return { ok: true };
  }

  private load(): void {
    try {
      const parsed = JSON.parse(readFileSync(this.file as string, "utf8")) as {
        days?: Record<string, number>;
        months?: Record<string, number>;
      };
      for (const [k, v] of Object.entries(parsed.days ?? {})) {
        if (typeof v === "number" && v > 0) this.days.set(k, v);
      }
      for (const [k, v] of Object.entries(parsed.months ?? {})) {
        if (typeof v === "number" && v > 0) this.months.set(k, v);
      }
    } catch {
      return;
    }
  }

  private save(): void {
    if (!this.file) return;
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      const tmp = `${this.file}.${process.pid}.tmp`;
      writeFileSync(
        tmp,
        JSON.stringify({ days: Object.fromEntries(this.days), months: Object.fromEntries(this.months) }),
        "utf8",
      );
      renameSync(tmp, this.file);
    } catch {
      return;
    }
  }
}
