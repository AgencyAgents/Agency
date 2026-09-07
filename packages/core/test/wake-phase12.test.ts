import { describe, expect, it } from "bun:test";
import { checkCompletion, NoProgressTracker } from "../src/team/closure.ts";
import { BoardStore } from "../src/team/todo.ts";
import { type WakeInterest, WakeRegistry, wakeMatches, wakeScopeOverlaps } from "../src/team/wake.ts";

function reviewItem(board: BoardStore, id: string): void {
  const filed = board.file({ id, content: `slice ${id}`, pathScope: ["src/auth/**"] }, "lead");
  expect(filed.ok).toBe(true);
  const moved = board.setStatus("lead", id, "ready_for_review", {
    filesTouched: [],
    verificationRun: "bun test",
    decisions: [],
    openQuestions: [],
  });
  expect(moved.ok).toBe(true);
}

describe("phase 12 wake interests", () => {
  it("a security interest on src/auth/** wakes on the matching review", () => {
    const registry = new WakeRegistry();
    expect(registry.subscribe({ handle: "security", pathScopes: ["src/auth/**"] }).ok).toBe(true);
    const board = new BoardStore();
    reviewItem(board, "auth-1");
    const matches = registry.matchForItem(board.list()[0]!);
    expect(matches.map((m) => m.handle)).toEqual(["security"]);
  });

  it("nothing wakes on a disjoint scope, a missing scope, or a non-review status", () => {
    const registry = new WakeRegistry();
    registry.subscribe({ handle: "security", pathScopes: ["src/auth/**"] });
    const board = new BoardStore();
    const db = board.file({ id: "db-1", content: "db slice", pathScope: ["src/db/**"] }, "lead");
    expect(db.ok).toBe(true);
    const scoped = board.file({ id: "db-2", content: "db slice", pathScope: ["src/db/**"] }, "lead");
    expect(scoped.ok).toBe(true);
    board.setStatus("lead", "db-2", "ready_for_review", {
      filesTouched: [],
      verificationRun: "bun test",
      decisions: [],
      openQuestions: [],
    });
    const unscoped = board.file({ id: "loose-1", content: "no scope" }, "lead");
    expect(unscoped.ok).toBe(true);
    board.setStatus("lead", "loose-1", "ready_for_review", {
      filesTouched: [],
      verificationRun: "bun test",
      decisions: [],
      openQuestions: [],
    });
    for (const item of board.list()) expect(registry.matchForItem(item)).toEqual([]);
    expect(
      wakeMatches(
        { handle: "security", pathScopes: ["src/auth/**"], onEvent: "ready_for_review" },
        board.list()[0]!,
      ),
    ).toBe(false);
  });

  it("a broader item scope still wakes the narrower interest", () => {
    const interest = {
      handle: "security",
      pathScopes: ["src/auth/**"],
      onEvent: "ready_for_review" as const,
    };
    expect(
      wakeScopeOverlaps(interest, {
        id: "w",
        content: "w",
        status: "ready_for_review",
        pathScope: ["src/**"],
      }),
    ).toBe(true);
    expect(
      wakeScopeOverlaps(interest, {
        id: "n",
        content: "n",
        status: "ready_for_review",
        pathScope: ["src/auth/login.ts"],
      }),
    ).toBe(true);
    expect(
      wakeScopeOverlaps(interest, {
        id: "d",
        content: "d",
        status: "ready_for_review",
        pathScope: ["src/db/**"],
      }),
    ).toBe(false);
  });

  it("unsubscribe ends the wake and bad subscriptions are refused", () => {
    const registry = new WakeRegistry();
    registry.subscribe({ handle: "security", pathScopes: ["src/auth/**"] });
    expect(registry.unsubscribe("security")).toBe(true);
    expect(registry.list()).toEqual([]);
    const board = new BoardStore();
    reviewItem(board, "auth-2");
    expect(registry.matchForItem(board.list()[0]!)).toEqual([]);
    expect(registry.subscribe({ handle: "", pathScopes: ["src/auth/**"] }).ok).toBe(false);
    expect(registry.subscribe({ handle: "security", pathScopes: [] }).ok).toBe(false);
    expect(
      registry.subscribe({ handle: "security", pathScopes: ["src/auth/**"], onEvent: "completed" }).ok,
    ).toBe(false);
  });

  it("a wake-only team still halts on the no-progress detector", () => {
    const board = new BoardStore();
    const filed = board.file({ id: "w-1", content: "watched slice", pathScope: ["src/auth/**"] }, "lead");
    expect(filed.ok).toBe(true);
    const tracker = new NoProgressTracker(5);
    expect(tracker.note(board.list())).toBe("progress");
    for (let n = 0; n < 4; n++) {
      board.setStatus("lead", "w-1", "pending");
      expect(tracker.note(board.list())).toBe("progress");
    }
    board.setStatus("lead", "w-1", "pending");
    expect(tracker.note(board.list())).toBe("stalled");
    expect(checkCompletion(board.list(), true).complete).toBe(false);
  });

  it("a wake-only team completes when its items close and agents idle", () => {
    const board = new BoardStore();
    const filed = board.file({ id: "w-1", content: "watched slice", pathScope: ["src/auth/**"] }, "lead");
    expect(filed.ok).toBe(true);
    expect(checkCompletion(board.list(), true).complete).toBe(false);
    board.setStatus("reviewer", "w-1", "completed");
    expect(checkCompletion(board.list(), true)).toEqual({ complete: true, outcome: "complete" });
  });
});

describe("phase 12 hardening — trim, bad input, scope trim, frozen copies, overlap directions", () => {
  it("subscribe/unsubscribe/get agree on normalized handles", () => {
    const registry = new WakeRegistry();
    const sub = registry.subscribe({ handle: "  alice  ", pathScopes: ["src/auth/**"] });
    expect(sub.ok).toBe(true);
    expect((sub as { ok: true; interest: WakeInterest }).interest.handle).toBe("alice");
    expect(registry.get("alice")).toBeDefined();
    expect(registry.get("  alice  ")).toBeDefined();
    expect(registry.unsubscribe("  alice  ")).toBe(true);
    expect(registry.get("alice")).toBeUndefined();
  });

  it("non-string or missing handle returns ok:false, never throws", () => {
    const registry = new WakeRegistry();
    // @ts-expect-error testing invalid input
    expect(registry.subscribe({ handle: 42, pathScopes: ["src/auth/**"] }).ok).toBe(false);
    // @ts-expect-error testing missing handle
    expect(registry.subscribe({ pathScopes: ["src/auth/**"] } as Record<string, unknown>).ok).toBe(false);
    // @ts-expect-error testing null req
    expect(registry.subscribe(null as unknown as { handle: string; pathScopes: string[] }).ok).toBe(false);
  });

  it("whitespace-padded scopes are stored trimmed", () => {
    const registry = new WakeRegistry();
    const sub = registry.subscribe({ handle: "sec", pathScopes: ["  src/auth/**  ", " src/db/** "] });
    expect(sub.ok).toBe(true);
    const interest = registry.get("sec")!;
    expect(interest.pathScopes).toEqual(["src/auth/**", "src/db/**"]);
  });

  it("frozen copies prevent registry state corruption", () => {
    const registry = new WakeRegistry();
    registry.subscribe({ handle: "sec", pathScopes: ["src/auth/**"] });
    const got = registry.get("sec")!;
    got.pathScopes.push("src/db/**");
    expect(registry.get("sec")!.pathScopes).toEqual(["src/auth/**"]);
    const listed = registry.list();
    listed[0]!.pathScopes.push("src/db/**");
    expect(registry.list()[0]!.pathScopes).toEqual(["src/auth/**"]);
  });

  it("wakeScopeOverlaps: narrower item scope wakes broader interest", () => {
    expect(
      wakeScopeOverlaps(
        { handle: "sec", pathScopes: ["src/**"], onEvent: "ready_for_review" },
        { id: "a", content: "a", status: "ready_for_review", pathScope: ["src/auth/login.ts"] },
      ),
    ).toBe(true);
  });

  it("wakeScopeOverlaps: broader item scope wakes narrower interest", () => {
    expect(
      wakeScopeOverlaps(
        { handle: "sec", pathScopes: ["src/auth/**"], onEvent: "ready_for_review" },
        { id: "b", content: "b", status: "ready_for_review", pathScope: ["src/**"] },
      ),
    ).toBe(true);
  });
});
