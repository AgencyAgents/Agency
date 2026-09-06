import { describe, expect, it } from "bun:test";
import {
  LEAN_BRIEF_MAX_CHARS,
  LEAN_PROMPT_MAX_CHARS,
  LEAN_SUMMARY_MAX_CHARS,
  leanBrief,
  leanPrompt,
  leanSummary,
  PromiseBarrier,
  spawnParallel,
} from "../src/team/parallel.ts";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe("parallel spawn + promise barrier (item 52)", () => {
  it("spawns 6 specialists concurrently and keeps input order", async () => {
    let active = 0;
    let maxActive = 0;
    const items = ["a", "b", "c", "d", "e", "f"];
    const { results, errors, settled } = await spawnParallel(items, async (item, index) => {
      active++;
      maxActive = Math.max(maxActive, active);
      // Later items finish first: completion order differs from input order.
      await sleep((items.length - index) * 10);
      active--;
      return `${item}-done`;
    });
    expect(maxActive).toBe(6);
    expect(results).toEqual(["a-done", "b-done", "c-done", "d-done", "e-done", "f-done"]);
    expect(errors).toEqual([undefined, undefined, undefined, undefined, undefined, undefined]);
    expect(settled.every((s) => s.ok)).toBe(true);
    expect(settled.map((s) => s.index)).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it("notifies exactly once via the barrier when the batch settles", async () => {
    let notifications = 0;
    let notifiedCount = 0;
    const barrier = new PromiseBarrier<string>(5, (settled) => {
      notifications++;
      notifiedCount = settled.length;
    });
    expect(barrier.isSettled).toBe(false);
    await spawnParallel([1, 2, 3, 4, 5], async (n, index) => {
      await sleep(5);
      barrier.complete(index, `v${n}`);
      return `v${n}`;
    });
    // spawnParallel has its own barrier; the manual one settles via complete().
    const settled = await barrier.wait();
    expect(notifications).toBe(1);
    expect(notifiedCount).toBe(5);
    expect(settled.map((s) => s.value)).toEqual(["v1", "v2", "v3", "v4", "v5"]);
    expect(barrier.completedCount).toBe(5);
    expect(barrier.isSettled).toBe(true);
  });

  it("captures one failure per slot without taking down peers", async () => {
    const { results, errors, settled } = await spawnParallel([0, 1, 2, 3, 4], async (n) => {
      await sleep(5);
      if (n === 2) throw new Error("boom-2");
      return `ok-${n}`;
    });
    expect(results[0]).toBe("ok-0");
    expect(results[4]).toBe("ok-4");
    expect(String(errors[2])).toContain("boom-2");
    expect(settled[2]!.ok).toBe(false);
    expect(settled.filter((s) => s.ok).length).toBe(4);
  });

  it("keeps context lean: brief/prompt/summary caps", () => {
    const brief = "x".repeat(LEAN_BRIEF_MAX_CHARS + 100);
    expect(leanBrief(brief).length).toBe(LEAN_BRIEF_MAX_CHARS);
    expect(leanBrief("short")).toBe("short");
    const multi = `first line stays\nsecond line is dropped ${"y".repeat(LEAN_SUMMARY_MAX_CHARS + 10)}`;
    const summary = leanSummary(multi);
    expect(summary).not.toContain("\n");
    expect(summary.startsWith("first line stays")).toBe(true);
    expect(leanSummary("a".repeat(LEAN_SUMMARY_MAX_CHARS + 5)).length).toBe(LEAN_SUMMARY_MAX_CHARS);
    expect(leanPrompt("p".repeat(LEAN_PROMPT_MAX_CHARS + 9)).length).toBe(LEAN_PROMPT_MAX_CHARS);
  });

  it("aborted spawn fails the slot instead of running the child", async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    let ran = 0;
    const { errors } = await spawnParallel(
      [1, 2],
      async () => {
        ran++;
        return "never";
      },
      { signal: ctrl.signal },
    );
    expect(ran).toBe(0);
    expect(errors.length).toBe(2);
    expect(String(errors[0])).toContain("aborted");
  });

  it("empty batch settles immediately with one notification", async () => {
    let notified = 0;
    const { results } = await spawnParallel([], async () => "x", {
      onSettle: () => {
        notified++;
      },
    });
    expect(results).toEqual([]);
    expect(notified).toBe(1);
    const barrier = new PromiseBarrier<number>(0);
    expect(barrier.isSettled).toBe(true);
    expect(await barrier.wait()).toEqual([]);
  });

  it("duplicate completion for a slot is ignored", async () => {
    let notified = 0;
    const barrier = new PromiseBarrier<string>(1, () => {
      notified++;
    });
    barrier.complete(0, "first");
    barrier.complete(0, "second");
    barrier.fail(0, new Error("late"));
    const settled = await barrier.wait();
    expect(settled[0]!.value).toBe("first");
    expect(notified).toBe(1);
    expect(barrier.completedCount).toBe(1);
  });
});
