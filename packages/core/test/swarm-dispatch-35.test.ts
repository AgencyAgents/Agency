import { describe, expect, it } from "bun:test";
import { createDispatchTool } from "../src/orchestra/dispatch.ts";

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
