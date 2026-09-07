import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProgressStore } from "../src/progress/store.ts";
import { planCompaction } from "../src/sessions/compaction.ts";
import type { SessionEntry } from "../src/sessions/entry.ts";
import {
  boardCompletion,
  boardToPlanFile,
  boardToTodos,
  planFileToBoard,
  planStepsToTasks,
  teamStatusLine,
  todosToBoard,
} from "../src/team/handoff.ts";
import { loadOwnersFile, ownersForPath, parseOwnersFile } from "../src/team/owners.ts";
import { recoverTeamBoard } from "../src/team/recovery.ts";
import { ensureTeamForLeadSession, TeamStore } from "../src/team/team-store.ts";
import { BoardStore } from "../src/team/todo.ts";
import { AgentWindowStore, TeamWindowStore } from "../src/team/windows.ts";

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), "agency-phase6-"));
}

const RESULT = {
  filesTouched: ["src/auth/login.ts"],
  verificationRun: "bun test",
  decisions: ["D-1 use zod"],
  openQuestions: [],
};

describe("team windows and item-aware compaction", () => {
  it("agent window compacts with the item contract verbatim, second compaction raises a board event", () => {
    const root = tempRoot();
    const board = new BoardStore();
    const filed = board.file(
      {
        id: "item-1",
        content: "auth slice",
        acceptanceCriteria: "login passes",
        pathScope: ["src/auth/**"],
      },
      "lead",
    );
    expect(filed.ok).toBe(true);
    const windows = new AgentWindowStore(root, (teamId, itemId, handle) => {
      board.record(itemId, handle, "compact-second", teamId);
    });
    windows.open("team-a", "item-1", "coder");
    const first = windows.compact("team-a", "item-1", {
      contract: filed.ok ? filed.item : { id: "item-1", content: "", status: "pending" as const },
      decisions: ["D-1 use zod"],
      filesTouched: ["src/auth/login.ts"],
      verification: "bun test green",
      openQuestions: ["token ttl?"],
      exploration: ["src/auth/x.ts:read more output here"],
    });
    expect(first?.second).toBe(false);
    expect(first?.text).toContain("auth slice");
    expect(first?.text).toContain("login passes");
    expect(first?.text).toContain("src/auth/login.ts");
    expect(first?.text).toContain("bun test green");
    expect(first?.text).toContain("token ttl?");
    const second = windows.compact("team-a", "item-1", {
      contract: filed.ok ? filed.item : { id: "item-1", content: "", status: "pending" as const },
      decisions: [],
      filesTouched: [],
      verification: "",
      openQuestions: [],
      exploration: [],
    });
    expect(second?.second).toBe(true);
    expect(board.listEvents().some((e) => e.move === "compact-second")).toBe(true);
    const closed = windows.close("team-a", "item-1", { spans: [], cassette: "cass-1" });
    expect(closed?.live).toBe(false);
    expect(closed?.record?.cassette).toBe("cass-1");
  });

  it("team window compacts to decisions plus board state with no item lost", () => {
    const root = tempRoot();
    const store = new TeamWindowStore(root);
    store.open("team-a", "lead-1", 5);
    store.decide("team-a", "D-1 use zod");
    store.snapshotBoard("team-a", [
      { id: "a", content: "one", status: "completed" },
      { id: "b", content: "two", status: "in_progress" },
    ]);
    store.appendTranscript("team-a", "long free text");
    const compacted = store.compactTeamWindow("team-a");
    expect(compacted?.decisions).toEqual(["D-1 use zod"]);
    expect(compacted?.boardSnapshot.length).toBe(2);
    expect(compacted?.transcript.length).toBe(1);
    expect(store.statusLine("team-a")).toContain("2 items");
  });

  it("item_state entries survive planCompaction like todo_state", () => {
    const message = (text: string): SessionEntry => ({
      id: text,
      parentId: null,
      schemaVersion: 2,
      createdAt: new Date().toISOString(),
      type: "message",
      message: { role: "user", content: [{ type: "text", text }] },
    });
    const chain: SessionEntry[] = [
      {
        id: "item-state-1",
        parentId: null,
        schemaVersion: 2,
        createdAt: new Date().toISOString(),
        type: "item_state",
        itemId: "item-1",
        contract: "auth slice",
      },
      message("old-1"),
      message("old-2"),
      message("old-3"),
      message("old-4"),
      message("old-5"),
      message("keep-1"),
      message("keep-2"),
      message("keep-3"),
      message("keep-4"),
    ];
    const plan = planCompaction(chain, 4);
    expect(plan.carryForward.some((e) => e.type === "item_state")).toBe(true);
  });
});

describe("crash recovery", () => {
  it("board reloads, dead claims release, orphaned worktrees become needs-user", () => {
    const board = new BoardStore();
    board.file({ id: "item-1", content: "a", pathScope: ["src/a/**"] }, "lead");
    board.file({ id: "item-2", content: "b", pathScope: ["src/b/**"] }, "lead");
    board.claim("coder", "item-1");
    board.claim("ghost", "item-2");
    const persisted = board.list();
    const fresh = new BoardStore();
    const summary = recoverTeamBoard({
      board: fresh,
      persisted,
      liveTurn: (claimedBy) => claimedBy === "coder",
      worktrees: [
        { path: "/tmp/wt-orphan", branch: "agency/x", hasUncommitted: true },
        { path: "/tmp/wt-clean", branch: "agency/y", hasUncommitted: false },
      ],
    });
    expect(summary.reloaded).toBe(3);
    expect(summary.released).toEqual(["item-2"]);
    expect(summary.orphans.length).toBe(1);
    const orphan = fresh.list().find((i) => i.id === summary.orphans[0]);
    expect(orphan?.status).toBe("needs-user");
    expect(fresh.list().find((i) => i.id === "item-1")?.claimedBy).toBe("coder");
    expect(fresh.list().find((i) => i.id === "item-2")?.status).toBe("pending");
  });
});

describe("plan gate, todos handoff, progress projection", () => {
  it("a blocking plan severity refuses conversion", () => {
    const board = new BoardStore();
    const blocked = planStepsToTasks(
      board,
      { pass: false, reason: "fail-blocking-severity" },
      [{ title: "do it" }],
      "lead",
    );
    expect(blocked.ok).toBe(false);
    expect(board.list().length).toBe(0);
    const passing = planStepsToTasks(
      board,
      { pass: true, reason: "pass-clean" },
      [{ title: "do it", pathScope: ["src/a/**"] }],
      "lead",
    );
    expect(passing.ok).toBe(true);
  });

  it("session todos hand off to the board and back", () => {
    const board = new BoardStore();
    const { filed } = todosToBoard(
      board,
      [
        { id: "t-1", content: "solo task", status: "pending" },
        { id: "t-2", content: "done task", status: "completed" },
      ],
      "lead",
    );
    expect(filed).toEqual(["t-1"]);
    board.claim("coder", "t-1");
    const back = boardToTodos(board.list());
    expect(back).toEqual([{ id: "t-1", content: "solo task", status: "in_progress" }]);
    expect(boardCompletion(board.list())).toBe("incomplete");
    expect(teamStatusLine(board.list(), 0.83)).toContain("1 items");
  });

  it("board projects to a plan file and reloads with order, F-gate, and attribution", () => {
    const root = tempRoot();
    const board = new BoardStore();
    board.file({ id: "item-1", content: "auth slice" }, "lead");
    board.file({ id: "item-2", content: "db slice" }, "lead");
    board.claim("coder", "item-1");
    board.setStatus("coder", "item-1", "ready_for_review", RESULT);
    const file = boardToPlanFile(board.list());
    expect(file).toContain("## Todos");
    expect(file).toContain("## Final");
    expect(file.indexOf("item-2")).toBeLessThan(file.indexOf("item-1"));

    const progress = new ProgressStore(root);
    progress.startTask("todos:item-2", { title: "db slice", agent: "coder", sessionId: "s-1" });
    progress.completeTask("todos:item-2");
    expect(progress.getTask("todos:item-2")?.agent).toBe("coder");
    progress.save();

    const fresh = new BoardStore();
    fresh.file({ id: "item-1", content: "auth slice" }, "lead");
    fresh.file({ id: "item-2", content: "db slice" }, "lead");
    fresh.claim("coder", "item-1");
    fresh.setStatus("coder", "item-1", "ready_for_review", RESULT);
    const check = (text: string, id: string, mark: string): string =>
      text
        .split("\n")
        .map((line) => (line.includes(`(${id})`) ? line.replace(/- \[[ x]\]/, `- [${mark}]`) : line))
        .join("\n");
    planFileToBoard(fresh, check(file, "item-2", "x"), "lead");
    expect(fresh.list().find((i) => i.id === "item-2")?.status).toBe("completed");
    const reprojected = boardToPlanFile(fresh.list());
    expect(reprojected).toContain("- [x] 1. db slice (item-2)");
    const picked = planFileToBoard(fresh, check(reprojected, "item-2", " "), "lead");
    expect(picked).toEqual(["item-2"]);
    expect(fresh.list().find((i) => i.id === "item-2")?.status).toBe("pending");
  });
});

describe("owners map", () => {
  it("owners_read resolves src/auth paths to the roles in .agency/owners", () => {
    const root = tempRoot();
    const rules = parseOwnersFile("src/auth/** @security @coder\n**/*.test.ts @test-writer\n");
    expect(ownersForPath(rules, "src/auth/login.ts")).toEqual(["security", "coder"]);
    expect(ownersForPath(rules, "src/auth/nested/x.test.ts")).toContain("test-writer");
    expect(ownersForPath(rules, "src/other/x.ts")).toEqual([]);
    mkdirSync(join(root, ".agency"), { recursive: true });
    writeFileSync(join(root, ".agency", "owners"), "src/auth/** @security @coder\n", "utf8");
    expect(ownersForPath(loadOwnersFile(root), "src/auth/login.ts")).toEqual(["security", "coder"]);
  });
});

describe("team per lead session", () => {
  it("one team per lead session with a stable id", () => {
    const store = new TeamStore();
    const first = ensureTeamForLeadSession(store, "lead-session-1", "goal", "lead");
    const second = ensureTeamForLeadSession(store, "lead-session-1", "goal", "lead");
    expect(first.id).toBe(second.id);
    expect(first.id).toContain("team-");
    const other = ensureTeamForLeadSession(store, "lead-session-2", "goal", "lead");
    expect(other.id).not.toBe(first.id);
  });
});
