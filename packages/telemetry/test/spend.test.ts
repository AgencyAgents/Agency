import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SpendLedger } from "../src/spend.ts";

describe("SpendLedger daily and monthly hard caps", () => {
  test("records spend into UTC day and month buckets", () => {
    const ledger = new SpendLedger({ now: () => Date.parse("2026-09-07T10:00:00Z") });
    ledger.record(1.5);
    ledger.record(0.5);
    expect(ledger.dayTotal()).toBeCloseTo(2, 9);
    expect(ledger.monthTotal()).toBeCloseTo(2, 9);
    expect(ledger.snapshot()).toMatchObject({ day: "2026-09-07", month: "2026-09" });
  });

  test("a fresh day starts at zero while the month accumulates", () => {
    let now = Date.parse("2026-09-07T10:00:00Z");
    const ledger = new SpendLedger({ now: () => now });
    ledger.record(2);
    now = Date.parse("2026-09-08T10:00:00Z");
    expect(ledger.dayTotal()).toBe(0);
    expect(ledger.monthTotal()).toBeCloseTo(2, 9);
  });

  test("check refuses when the estimate would exceed the daily cap", () => {
    const ledger = new SpendLedger({ now: () => Date.parse("2026-09-07T10:00:00Z") });
    ledger.record(0.09);
    const refused = ledger.check({ dailyUsd: 0.1 }, 0.02);
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.scope).toBe("daily");
    expect(ledger.check({ dailyUsd: 0.1 }, 0.005).ok).toBe(true);
    expect(ledger.check(undefined, 999).ok).toBe(true);
  });

  test("check refuses on the monthly cap independently of the daily cap", () => {
    const ledger = new SpendLedger({ now: () => Date.parse("2026-09-07T10:00:00Z") });
    ledger.record(4.9);
    const refused = ledger.check({ monthlyUsd: 5 }, 0.2);
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.scope).toBe("monthly");
  });

  test("spend survives a restart through the sessions-dir file", () => {
    const dir = mkdtempSync(join(tmpdir(), "agency-spend-test-"));
    try {
      const first = new SpendLedger({
        sessionsDir: dir,
        now: () => Date.parse("2026-09-07T10:00:00Z"),
      });
      first.record(1.25);
      const second = new SpendLedger({
        sessionsDir: dir,
        now: () => Date.parse("2026-09-07T12:00:00Z"),
      });
      expect(second.dayTotal()).toBeCloseTo(1.25, 9);
      expect(second.check({ dailyUsd: 1 }, 0.01).ok).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
