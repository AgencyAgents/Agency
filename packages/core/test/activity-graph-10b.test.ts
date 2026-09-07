import { describe, expect, test } from "bun:test";
import { BoardStore, buildActivityGraph, materializeDelegate } from "../src/index.ts";

function agentCostFromBoard(
  items: { claimedBy?: string; filedBy?: string; costUsd?: number }[],
): (handle: string) => number {
  return (handle) =>
    items.filter((i) => (i.claimedBy ?? i.filedBy) === handle).reduce((sum, i) => sum + (i.costUsd ?? 0), 0);
}

describe("phase 10b activity graph", () => {
  test("reconstructs the full delegation DAG from board state alone with costs summing to the run total", () => {
    const board = new BoardStore();
    const auth = board.file({ content: "ship auth" }, "lead");
    const db = board.file({ content: "ship db" }, "lead");
    expect(auth.ok && db.ok).toBe(true);
    const authId = (auth as { ok: true; item: { id: string } }).item.id;
    const dbId = (db as { ok: true; item: { id: string } }).item.id;

    const d1 = materializeDelegate(board, "coder", { brief: "research token refresh" }, "researcher");
    const d2 = materializeDelegate(board, "coder", { brief: "review the schema" }, "reviewer");
    expect(d1.ok && d2.ok).toBe(true);
    const researchId = (d1 as { ok: true; filed: { item: { id: string } } }).filed.item.id;
    const reviewId = (d2 as { ok: true; filed: { item: { id: string } } }).filed.item.id;

    expect(board.claim("coder", authId).ok).toBe(true);
    expect(board.claim("coder", dbId).ok).toBe(true);
    expect(board.claim("researcher", researchId).ok).toBe(true);
    expect(board.claim("reviewer", reviewId).ok).toBe(true);

    expect(board.recordCost(authId, 0.3, 3000)).toBe(true);
    expect(board.recordCost(dbId, 0.2, 2000)).toBe(true);
    expect(board.recordCost(researchId, 0.1, 1000)).toBe(true);
    expect(board.recordCost(reviewId, 0.05, 500)).toBe(true);
    expect(board.escalate("reviewer", reviewId, "which index type?").ok).toBe(true);

    const items = board.list();
    const runTotal = items.reduce((sum, i) => sum + (i.costUsd ?? 0), 0);
    expect(runTotal).toBeCloseTo(0.65, 9);

    const graph = buildActivityGraph({
      items,
      events: board.listEvents(),
      agents: [{ handle: "coder" }, { handle: "researcher" }, { handle: "reviewer" }],
      agentState: () => "idle",
      agentCost: agentCostFromBoard(items),
    });

    expect(graph.nodes.filter((n) => n.kind === "agent")).toHaveLength(3);
    expect(graph.nodes.filter((n) => n.kind === "task")).toHaveLength(4);
    const byId = new Map(graph.nodes.map((n) => [n.id, n]));
    expect(byId.get("task:needs-user")).toBeUndefined();
    expect(byId.get(`task:${reviewId}`)?.state).toBe("needs-user");
    expect(byId.get(`task:${reviewId}`)?.blockedReason).toBe("which index type?");
    expect(byId.get(`task:${authId}`)?.costUsd).toBeCloseTo(0.3, 9);

    const delegateEdges = graph.edges.filter((e) => e.reason === "delegate");
    expect(delegateEdges).toHaveLength(2);
    expect(delegateEdges).toContainEqual({
      from: "coder",
      to: "researcher",
      itemId: researchId,
      reason: "delegate",
    });
    expect(delegateEdges).toContainEqual({
      from: "coder",
      to: "reviewer",
      itemId: reviewId,
      reason: "delegate",
    });

    const agentSum = graph.nodes.filter((n) => n.kind === "agent").reduce((s, n) => s + n.costUsd, 0);
    const taskSum = graph.nodes.filter((n) => n.kind === "task").reduce((s, n) => s + n.costUsd, 0);
    expect(agentSum).toBeCloseTo(runTotal, 9);
    expect(taskSum).toBeCloseTo(runTotal, 9);
    expect(graph.totalUsd).toBeCloseTo(runTotal, 9);
  });
});
