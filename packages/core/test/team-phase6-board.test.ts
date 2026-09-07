import { describe, expect, it } from "bun:test";
import { join } from "node:path";
import { loadCassettes } from "../../eval/src/cassette.ts";
import { integrateSequentially } from "../src/team/integration.ts";
import { BoardStore } from "../src/team/todo.ts";

const LEAD = "lead";
const CODER = "coder";
const RESEARCHER = "researcher";

function seedBoard(): BoardStore {
  const board = new BoardStore();
  const scopes = ["src/auth/**", "src/db/**", "src/api/**", "src/ui/**"];
  scopes.forEach((scope, index) => {
    const filed = board.file(
      {
        id: `item-${index + 1}`,
        content: `work slice ${index + 1}`,
        acceptanceCriteria: `slice ${index + 1} done`,
        briefing: `brief ${index + 1}`,
        pathScope: [scope],
        budgetUsd: 1,
        budgetTurns: 4,
      },
      LEAD,
    );
    expect(filed.ok).toBe(true);
  });
  return board;
}

describe("team board flat topology end to end", () => {
  it("lead seeds four disjoint items, decline plus counter, three complete, lead integrates", async () => {
    const cassettes = loadCassettes(join(import.meta.dir, "..", "..", "eval", "cassettes"));
    const team = cassettes.find((c) => c.roster === "team");
    expect(team).toBeDefined();
    const multi = team?.tasks.find((t) => t.kind === "multi");
    expect(multi?.conflicts).toBeGreaterThan(0);

    const board = seedBoard();
    expect(board.claim(CODER, "item-1").ok).toBe(true);
    expect(board.decline(RESEARCHER, "item-2", "out of scope: needs db access").ok).toBe(true);
    const counter = board.counter(
      CODER,
      "item-3",
      { content: "narrower api slice", pathScope: ["src/api/v1/**"] },
      { pathScope: ["src/api/**"], tools: ["read", "write", "edit"] },
    );
    expect(counter.ok).toBe(true);
    if (!counter.ok) throw new Error("counter failed");
    expect(counter.item.pathScope).toEqual(["src/api/v1/**"]);

    const result = {
      filesTouched: ["src/auth/login.ts"],
      verificationRun: "bun test auth",
      decisions: ["use zod"],
      openQuestions: [],
    };
    expect(board.claim(CODER, counter.item.id).ok).toBe(true);
    expect(board.setStatus(CODER, "item-1", "ready_for_review", result).ok).toBe(true);
    expect(board.claim(RESEARCHER, "item-4").ok).toBe(true);
    expect(board.setStatus(RESEARCHER, "item-4", "ready_for_review", result).ok).toBe(true);
    expect(board.setStatus(CODER, counter.item.id, "ready_for_review", result).ok).toBe(true);

    const done = board.list().filter((i) => i.status === "ready_for_review");
    expect(done.length).toBe(3);

    const outcome = await integrateSequentially({
      board,
      leadHandle: LEAD,
      callerHandle: LEAD,
      targets: done.map((item, index) => ({
        itemId: item.id,
        path: `/tmp/wt-${index}`,
        branch: `agency/team/item-${index}`,
      })),
      merge: async () => ({ ok: true }),
    });
    expect(outcome.merged.length).toBe(3);
    expect(outcome.returned.length).toBe(0);
    expect(board.list().filter((i) => i.status === "completed").length).toBe(3);
  });

  it("a coder files an item a researcher claims with no lead involvement", () => {
    const board = new BoardStore();
    const filed = board.file({ content: "research oauth limits", pathScope: ["docs/**"] }, CODER);
    expect(filed.ok).toBe(true);
    if (!filed.ok) throw new Error("file failed");
    expect(board.claim(RESEARCHER, filed.item.id).ok).toBe(true);
    expect(board.list()[0]?.claimedBy).toBe(RESEARCHER);
  });

  it("contract moves record events and escalate parks in needs-user", () => {
    const board = seedBoard();
    expect(board.escalate(CODER, "item-1", "which schema?").ok).toBe(true);
    expect(board.list().find((i) => i.id === "item-1")?.status).toBe("needs-user");
    const moves = board.listEvents().map((e) => e.move);
    expect(moves).toContain("escalate");
    expect(moves).toContain("file");
  });

  it("structured return contract is required on review", () => {
    const board = seedBoard();
    expect(board.claim(CODER, "item-1").ok).toBe(true);
    expect(board.setStatus(CODER, "item-1", "ready_for_review", { nope: true }).ok).toBe(false);
    expect(
      board.setStatus(CODER, "item-1", "ready_for_review", {
        filesTouched: [],
        verificationRun: "bun test",
        decisions: [],
        openQuestions: [],
      }).ok,
    ).toBe(true);
  });

  it("hostile scope is intersected to the explorer grant and refused", () => {
    const board = new BoardStore();
    const explorerGrants = { pathScope: ["src/api/**"], tools: ["read", "glob", "grep"] };
    const hostile = board.file(
      { content: "rewrite everything", pathScope: ["/**"], tools: ["read", "write", "edit"] },
      "explorer",
      explorerGrants,
    );
    expect(hostile.ok).toBe(false);
  });

  it("narrower scopes survive intersection, budgets take the minimum", () => {
    const board = new BoardStore();
    const filed = board.file(
      {
        content: "api slice",
        pathScope: ["src/api/v1/**"],
        tools: ["read"],
        budgetUsd: 5,
        budgetTurns: 10,
      },
      "coder",
      { pathScope: ["src/api/**"], tools: ["read", "write"], budgetUsd: 2, budgetTurns: 4 },
    );
    expect(filed.ok).toBe(true);
    if (!filed.ok) throw new Error("file failed");
    expect(filed.item.pathScope).toEqual(["src/api/v1/**"]);
    expect(filed.item.budgetUsd).toBe(2);
    expect(filed.item.budgetTurns).toBe(4);
  });

  it("counter outside the item scope is refused", () => {
    const board = seedBoard();
    const counter = board.counter(CODER, "item-1", {
      content: "wider grab",
      pathScope: ["src/db/**"],
    });
    expect(counter.ok).toBe(false);
  });

  it("integration is lead-owned and merge failures return items to pending", async () => {
    const board = seedBoard();
    expect(board.claim(CODER, "item-1").ok).toBe(true);
    await expect(
      integrateSequentially({
        board,
        leadHandle: LEAD,
        callerHandle: CODER,
        targets: [{ itemId: "item-1", path: "/tmp/wt", branch: "b" }],
        merge: async () => ({ ok: true }),
      }),
    ).rejects.toThrow("lead-owned");
    const outcome = await integrateSequentially({
      board,
      leadHandle: LEAD,
      callerHandle: LEAD,
      targets: [{ itemId: "item-1", path: "/tmp/wt", branch: "b" }],
      merge: async () => ({ ok: false, conflict: "routes.ts both touched" }),
    });
    expect(outcome.merged.length).toBe(0);
    expect(board.list().find((i) => i.id === "item-1")?.status).toBe("pending");
  });
});
