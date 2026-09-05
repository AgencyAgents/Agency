import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDispatchTool } from "../src/orchestra/dispatch.ts";
import {
  DISPATCH_SKIP_REASONS,
  DispatchStateStore,
  formatSkipLine,
  planDispatchBatch,
  resolveDispatchTarget,
} from "../src/orchestra/dispatch-core.ts";

function handlerOf(tool: unknown) {
  return (
    tool as unknown as {
      handler: (input: unknown, ctx: unknown) => Promise<{ content: string; isError?: boolean }>;
    }
  ).handler;
}

describe("dispatch hardening (item 35)", () => {
  it("depth gate denies at maxDepth with a clean error", async () => {
    let called = false;
    const tool = createDispatchTool({
      maxDepth: 0,
      dispatch: async () => {
        called = true;
        return { content: "ok" };
      },
    });
    const res = await handlerOf(tool)({ agents: [{ handle: "a", brief: "b" }] }, { taskDepth: 0 });
    expect(res.isError).toBe(true);
    expect(res.content).toContain("depth limit reached (0 >= 0)");
    expect(called).toBe(false);
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

  it("nested dispatch blocked: subagent (taskDepth>0) cannot dispatch", async () => {
    let called = false;
    const tool = createDispatchTool({
      dispatch: async () => {
        called = true;
        return { content: "ok" };
      },
    });
    const res = await handlerOf(tool)({ agents: [{ handle: "a", brief: "b" }] }, { taskDepth: 1 });
    expect(res.isError).toBe(true);
    expect(res.content).toBe("nested dispatch blocked: subagents cannot dispatch");
    expect(called).toBe(false);
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
    expect([...DISPATCH_SKIP_REASONS].sort()).toEqual(
      [
        "depth-limit",
        "empty-input",
        "invalid-entry",
        "nested-blocked",
        "orchestra-budget-exceeded",
        "per-agent-budget-exceeded",
        "unknown-handle",
      ].sort(),
    );
    const get = registryOf([{ handle: "a" }]).get;
    const empty = planDispatchBatch([], { resolveHandle: get });
    expect(empty.skips[0]!.reason).toBe("empty-input");
    const invalid = planDispatchBatch([{ handle: "", brief: "" }], { resolveHandle: get });
    expect(invalid.skips[0]!.reason).toBe("invalid-entry");
    const unknown = planDispatchBatch([{ handle: "ghost", brief: "b" }], { resolveHandle: get });
    expect(unknown.skips[0]!.reason).toBe("unknown-handle");
    const nested = planDispatchBatch([{ handle: "a", brief: "b" }], { resolveHandle: get, taskDepth: 1 });
    expect(nested.skips[0]!.reason).toBe("nested-blocked");
    const deep = planDispatchBatch([{ handle: "a", brief: "b" }], {
      resolveHandle: get,
      taskDepth: 0,
      maxDepth: 0,
    });
    expect(deep.skips[0]!.reason).toBe("depth-limit");
    const orch = planDispatchBatch([{ handle: "a", brief: "b" }], {
      resolveHandle: get,
      orchestraTotal: 5,
      budgets: { orchestraUsd: 1 },
    });
    expect(orch.skips[0]!.reason).toBe("orchestra-budget-exceeded");
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
      expect(DISPATCH_SKIP_REASONS).toContain((res as { reason?: string }).reason);
    }
    const nested = await handlerOf(tool)({ agents: [{ handle: "a", brief: "b" }] }, { taskDepth: 1 });
    expect((nested as { reason?: string }).reason).toBe("nested-blocked");
    expect(nested.content).toBe("nested dispatch blocked: subagents cannot dispatch");
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
