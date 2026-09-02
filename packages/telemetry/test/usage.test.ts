import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore } from "@agency/core";
import {
  appendUsageEntry,
  cacheHitRate,
  formatCacheHitRate,
  formatCostUsd,
  isUsageEntry,
  SessionUsageTracker,
  turnCostUsd,
  usageEntry,
} from "../src/usage.ts";

const PRICING = { inputPerMTok: 3, outputPerMTok: 15, cachedInputPerMTok: 0.3 };

describe("usage accounting", () => {
  test("cacheHitRate is undefined when the provider reports no cache data", () => {
    expect(cacheHitRate({ inputTokens: 100, outputTokens: 10 })).toBeUndefined();
  });

  test("cacheHitRate is capped at 1 and handles a zero denominator", () => {
    expect(cacheHitRate({ inputTokens: 80, outputTokens: 10, cachedInputTokens: 80 })).toBe(1);
    expect(cacheHitRate({ inputTokens: 0, outputTokens: 0, cachedInputTokens: 5 })).toBe(1);
    expect(cacheHitRate({ inputTokens: 0, outputTokens: 0 })).toBeUndefined();
  });

  test("turnCostUsd prices cached input at the cached rate", () => {
    const usage = { inputTokens: 1_000_000, outputTokens: 1_000_000, cachedInputTokens: 400_000 };
    // 600k uncached at $3 + 400k cached at $0.30 + 1M output at $15
    expect(turnCostUsd(usage, PRICING)).toBeCloseTo(1.8 + 0.12 + 15, 6);
    expect(turnCostUsd(usage)).toBe(0);
  });

  test("SessionUsageTracker totals turns and reports the aggregate hit rate", () => {
    const tracker = new SessionUsageTracker();
    tracker.addTurn({ model: "m", usage: { inputTokens: 100, outputTokens: 20, cachedInputTokens: 80 } });
    tracker.addTurn({ model: "m", usage: { inputTokens: 100, outputTokens: 30 } });

    const summary = tracker.summary();
    expect(summary.turns).toBe(2);
    expect(summary.inputTokens).toBe(200);
    expect(summary.outputTokens).toBe(50);
    expect(summary.cachedInputTokens).toBe(80);
    expect(summary.cacheHitRate).toBeCloseTo(0.4, 6);
  });

  test("usageEntry and appendUsageEntry persist an additive session entry", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agency-usage-test-"));
    const store = new SessionStore(dir);
    store.create("s1");
    const user = await store.append("s1", {
      type: "message",
      parentId: null,
      message: { role: "user", content: [{ type: "text", text: "hi" }] },
    });

    const turn = {
      usage: { inputTokens: 50, outputTokens: 10, cachedInputTokens: 25 },
      model: "m",
      pricing: PRICING,
    };
    const usageId = await appendUsageEntry(store, "s1", user.id, turn);

    const entries = store.load("s1");
    expect(entries).toHaveLength(2);
    const last = entries[1]!;
    expect(isUsageEntry(last)).toBe(true);
    expect(last.parentId).toBe(user.id);
    expect(last.id).toBe(usageId);
    expect(last.type).toBe("usage");
    expect((last as Record<string, unknown>).costUsd).toBe(turnCostUsd(turn.usage, PRICING));

    // The persisted line is the usage entry plus the session envelope (R5).
    const raw = JSON.parse(readFileSync(join(dir, "s1.jsonl"), "utf8").split("\n")[1]!) as Record<
      string,
      unknown
    >;
    const { id: _id, parentId: _parentId, schemaVersion: _v, createdAt: _c, ...usageFields } = raw;
    expect(usageFields).toEqual(usageEntry(turn) as unknown as Record<string, unknown>);
    rmSync(dir, { recursive: true, force: true });
  });

  test("formatters", () => {
    expect(formatCostUsd(0)).toBe("$0.00");
    expect(formatCostUsd(0.001)).toBe("$0.0010");
    expect(formatCostUsd(1.5)).toBe("$1.50");
    expect(formatCacheHitRate(undefined)).toBe("n/a");
    expect(formatCacheHitRate(0.856)).toBe("86%");
  });
});
