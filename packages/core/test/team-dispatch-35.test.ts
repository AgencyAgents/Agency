import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDispatchTool } from "../src/team/dispatch.ts";
import {
  DISPATCH_SKIP_REASONS,
  type DispatchSkipReason,
  DispatchStateStore,
  formatSkipLine,
  planDispatchBatch,
  resolveDispatchTarget,
} from "../src/team/dispatch-core.ts";

function handlerOf(tool: unknown) {
  return (
    tool as unknown as {
      handler: (input: unknown, ctx: unknown) => Promise<{ content: string; isError?: boolean }>;
    }
  ).handler;
}

describe("dispatch hardening (item 35)", () => {
  it("flat team path carries no depth gate: any inherited depth dispatches", async () => {
    let called = false;
    const tool = createDispatchTool({
      dispatch: async () => {
        called = true;
        return { content: "ok" };
      },
    });
    for (const depth of [0, 1, 3]) {
      const res = await handlerOf(tool)({ agents: [{ handle: "a", brief: "b" }] }, { taskDepth: depth });
      expect(res.isError).not.toBe(true);
    }
    expect(called).toBe(true);
  });

  it("passes taskDepth, signal and requestApproval through exactly once (daemon adds +1)", async () => {
    let seen: unknown = null;
    const signal = new AbortController().signal;
    const requestApproval = async () => "once" as const;
    const tool = createDispatchTool({
      dispatch: async (_input, ctx) => {
        seen = ctx;
        return { content: "ok" };
      },
    });
    const res = await handlerOf(tool)(
      { agents: [{ handle: "a", brief: "b" }] },
      { taskDepth: 0, signal, requestApproval },
    );
    expect(res.isError).not.toBe(true);
    const ctx = seen as { taskDepth: number; signal: AbortSignal; requestApproval: unknown };
    expect(ctx.taskDepth).toBe(0);
    expect(ctx.signal).toBe(signal);
    expect(ctx.requestApproval).toBe(requestApproval);
  });

  it("rejects missing/empty agents input fail-closed", async () => {
    let called = false;
    const tool = createDispatchTool({
      dispatch: async () => {
        called = true;
        return { content: "ok" };
      },
    });
    for (const bad of [
      undefined,
      null,
      {},
      { agents: [] },
      { agents: [{ handle: "", brief: "b" }] },
      { agents: [{ handle: "a", brief: "" }] },
    ]) {
      const res = await handlerOf(tool)(bad, { taskDepth: 0 });
      expect(res.isError).toBe(true);
    }
    expect(called).toBe(false);
  });

  it("renderCall names handles; renderResult collapses to one line", async () => {
    const tool = createDispatchTool({ dispatch: async () => ({ content: "x" }) });
    const t = tool as unknown as { renderCall: (i: unknown) => string; renderResult: (r: unknown) => string };
    expect(
      t.renderCall({
        agents: [
          { handle: "a", brief: "x" },
          { handle: "b", brief: "y" },
        ],
      }),
    ).toContain("a");
    expect(
      t.renderResult({ content: "a dispatched: foo\nb dispatched: bar", isError: false }).split("\n").length,
    ).toBe(1);
    expect(t.renderResult({ content: "boom", isError: true })).toContain("dispatch failed");
  });

  it("subagent taskDepth forwards to dispatch for spawn-rule inheritance", async () => {
    let seen: unknown = null;
    const tool = createDispatchTool({
      dispatch: async (_input, ctx) => {
        seen = ctx;
        return { content: "ok" };
      },
    });
    const res = await handlerOf(tool)({ agents: [{ handle: "a", brief: "b" }] }, { taskDepth: 1 });
    expect(res.isError).not.toBe(true);
    expect((seen as { taskDepth: number }).taskDepth).toBe(1);
  });
});

describe("unified dispatch path U9", () => {
  const registryOf = (entries: Array<{ handle: string; effort?: string; model?: string }>) => ({
    get: (handle: string) => entries.find((e) => e.handle === handle),
  });

  it("single entry partitions every request into targets or skips, never silent", () => {
    const plan = planDispatchBatch(
      [
        { handle: "a", brief: "one" },
        { handle: "", brief: "bad" },
        { handle: "ghost", brief: "missing" },
      ],
      { resolveHandle: registryOf([{ handle: "a" }]).get },
    );
    expect(plan.targets.length + plan.skips.length).toBe(3);
    expect(plan.targets.map((t) => t.handle)).toEqual(["a"]);
    for (const skip of plan.skips) {
      expect(DISPATCH_SKIP_REASONS).toContain(skip.reason);
      expect(skip.detail.length).toBeGreaterThan(0);
    }
  });

  it("override precedence is per-agent over registry over default", () => {
    const get = registryOf([{ handle: "a", effort: "low", model: "reg-model" }]).get;
    const perAgent = resolveDispatchTarget(
      { handle: "a", brief: "b", effort: "high", model: "req-model" },
      get("a"),
      { effort: "medium", model: "default-model" },
    );
    expect(perAgent.effort).toBe("high");
    expect(perAgent.model).toBe("req-model");
    const registryWins = resolveDispatchTarget({ handle: "a", brief: "b" }, get("a"), {
      effort: "medium",
      model: "default-model",
    });
    expect(registryWins.effort).toBe("low");
    expect(registryWins.model).toBe("reg-model");
    const defaultWins = resolveDispatchTarget({ handle: "a", brief: "b" }, undefined, {
      effort: "medium",
    });
    expect(defaultWins.effort).toBe("medium");
  });

  it("skip reason codes are stable strings and every code is producible", () => {
    const expected: DispatchSkipReason[] = [
      "empty-input",
      "invalid-entry",
      "team-budget-exceeded",
      "per-agent-budget-exceeded",
      "unknown-handle",
    ];
    expect([...DISPATCH_SKIP_REASONS].sort()).toEqual(expected.sort());
    const get = registryOf([{ handle: "a" }]).get;
    const empty = planDispatchBatch([], { resolveHandle: get });
    expect(empty.skips[0]!.reason).toBe("empty-input");
    const invalid = planDispatchBatch([{ handle: "", brief: "" }], { resolveHandle: get });
    expect(invalid.skips[0]!.reason).toBe("invalid-entry");
    const unknown = planDispatchBatch([{ handle: "ghost", brief: "b" }], { resolveHandle: get });
    expect(unknown.skips[0]!.reason).toBe("unknown-handle");
    const orch = planDispatchBatch([{ handle: "a", brief: "b" }], {
      resolveHandle: get,
      teamTotal: 5,
      budgets: { teamUsd: 1 },
    });
    expect(orch.skips[0]!.reason).toBe("team-budget-exceeded");
    const perAgent = planDispatchBatch([{ handle: "a", brief: "b" }], {
      resolveHandle: get,
      perAgentSpend: new Map([["a", 5]]),
      budgets: { perAgentUsd: 1 },
    });
    expect(perAgent.skips[0]!.reason).toBe("per-agent-budget-exceeded");
  });

  it("every skip formats with a machine-readable reason token, no silent skips", async () => {
    const tool = createDispatchTool({ dispatch: async () => ({ content: "ok" }) });
    for (const bad of [{ agents: [] }, { agents: [{ handle: "", brief: "b" }] }]) {
      const res = await handlerOf(tool)(bad, { taskDepth: 0 });
      expect(res.isError).toBe(true);
      expect((res as { reason?: string }).reason).toMatch(/^[a-z-]+$/);
      expect(DISPATCH_SKIP_REASONS).toContain((res as { reason?: DispatchSkipReason }).reason!);
    }
    const line = formatSkipLine({ index: 0, handle: "ghost", reason: "unknown-handle", detail: "nope" });
    expect(line).toContain("[skip:unknown-handle]");
    expect(line).toContain("ghost");
  });

  it("dispatch state survives a persist and reload roundtrip", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agency-u9-"));
    try {
      const file = join(dir, "dispatch-state.json");
      const store = new DispatchStateStore();
      store.append({ index: 0, handle: "a", brief: "one", status: "dispatched" });
      store.append({ index: 1, handle: "ghost", brief: "two", status: "skipped", reason: "unknown-handle" });
      await store.save(file);
      const reloaded = await DispatchStateStore.load(file);
      expect(reloaded.list()).toEqual(store.list());
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("persisted state with a version mismatch is ignored", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agency-u9-"));
    try {
      const file = join(dir, "dispatch-state.json");
      const { writeFileSync } = await import("node:fs");
      writeFileSync(file, JSON.stringify({ version: 9999, entries: [{ index: 0 }] }));
      const reloaded = await DispatchStateStore.load(file);
      expect(reloaded.list()).toEqual([]);
      expect(await DispatchStateStore.load(join(dir, "does-not-exist.json"))).toBeDefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("dispatch batch budgets accumulate intra-batch (item a)", () => {
  const registryOf = (entries: Array<{ handle: string }>) => ({
    get: (handle: string) => entries.find((e) => e.handle === handle),
  });

  it("a batch cannot exceed the team budget mid-batch", () => {
    const get = registryOf([{ handle: "a" }, { handle: "b" }, { handle: "c" }]).get;
    const plan = planDispatchBatch(
      [
        { handle: "a", brief: "one", costUsd: 1 },
        { handle: "b", brief: "two", costUsd: 1 },
        { handle: "c", brief: "three", costUsd: 1 },
      ],
      { resolveHandle: get, teamTotal: 0, budgets: { teamUsd: 2 } },
    );
    expect(plan.targets.map((t) => t.handle)).toEqual(["a", "b"]);
    expect(plan.skips.length).toBe(1);
    expect(plan.skips[0]!.handle).toBe("c");
    expect(plan.skips[0]!.reason).toBe("team-budget-exceeded");
  });

  it("a batch cannot exceed a per-agent budget mid-batch", () => {
    const get = registryOf([{ handle: "a" }]).get;
    const plan = planDispatchBatch(
      [
        { handle: "a", brief: "one", costUsd: 1 },
        { handle: "a", brief: "two", costUsd: 1 },
      ],
      {
        resolveHandle: get,
        perAgentSpend: new Map([["a", 0]]),
        budgets: { perAgentUsd: 1 },
      },
    );
    expect(plan.targets.length).toBe(1);
    expect(plan.skips.length).toBe(1);
    expect(plan.skips[0]!.reason).toBe("per-agent-budget-exceeded");
  });

  it("does not mutate the caller per-agent spend map", () => {
    const get = registryOf([{ handle: "a" }]).get;
    const spend = new Map([["a", 0]]);
    planDispatchBatch([{ handle: "a", brief: "one", costUsd: 1 }], {
      resolveHandle: get,
      perAgentSpend: spend,
      budgets: { perAgentUsd: 10 },
    });
    expect(spend.get("a")).toBe(0);
  });
});

describe("flat team path carries no depth codes (phase 8 decision a)", () => {
  it("spawn keeps the only depth rule; planDispatchBatch plans any inherited depth", () => {
    const plan = planDispatchBatch([{ handle: "a", brief: "b" }], {
      resolveHandle: () => ({ handle: "a" }),
    });
    expect(plan.targets).toHaveLength(1);
    expect(plan.skips).toEqual([]);
    expect(DISPATCH_SKIP_REASONS).not.toContain("depth-limit" as never);
    expect(DISPATCH_SKIP_REASONS).not.toContain("nested-blocked" as never);
  });
});

describe("dispatch load status (item c)", () => {
  it("missing file reports missing with an empty store", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agency-u9-"));
    try {
      const loaded = await DispatchStateStore.loadWithStatus(join(dir, "absent.json"));
      expect(loaded.status).toBe("missing");
      expect(loaded.store.list()).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("corrupt file reports corrupt with an empty store", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agency-u9-"));
    try {
      const file = join(dir, "dispatch-state.json");
      const { writeFileSync } = await import("node:fs");
      writeFileSync(file, "not json{{{");
      const loaded = await DispatchStateStore.loadWithStatus(file);
      expect(loaded.status).toBe("corrupt");
      expect(loaded.store.list()).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("version mismatch reports version-mismatch with an empty store", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agency-u9-"));
    try {
      const file = join(dir, "dispatch-state.json");
      const { writeFileSync } = await import("node:fs");
      writeFileSync(file, JSON.stringify({ version: 9999, entries: [] }));
      const loaded = await DispatchStateStore.loadWithStatus(file);
      expect(loaded.status).toBe("version-mismatch");
      expect(loaded.store.list()).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("valid file reports ok and silent load() still works", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agency-u9-"));
    try {
      const file = join(dir, "dispatch-state.json");
      const store = new DispatchStateStore();
      store.append({ index: 0, handle: "a", brief: "one", status: "dispatched" });
      await store.save(file);
      const loaded = await DispatchStateStore.loadWithStatus(file);
      expect(loaded.status).toBe("ok");
      expect(loaded.store.list()).toEqual(store.list());
      expect((await DispatchStateStore.load(file)).list()).toEqual(store.list());
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("dispatch fromJSON validation (item h)", () => {
  it("drops entries with bad status, reason, at, brief, model, or effort", async () => {
    const { DispatchStateStore: Store } = await import("../src/team/dispatch-core.ts");
    const good = { index: 0, handle: "a", brief: "one", status: "dispatched", at: new Date().toISOString() };
    const store = Store.fromJSON({
      version: 1,
      entries: [
        good,
        { ...good, index: 1, status: "bogus" },
        { ...good, index: 2, status: "skipped", reason: "bogus-reason" },
        { ...good, index: 3, at: "not-a-date" },
        { ...good, index: 4, brief: 42 },
        { ...good, index: 5, model: 42 },
        { ...good, index: 6, effort: 42 },
        { ...good, index: 7, status: "skipped", reason: "unknown-handle" },
      ],
    });
    expect(store.list().map((e) => e.index)).toEqual([0, 7]);
  });
});
