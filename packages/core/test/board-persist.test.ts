import { afterEach, describe, expect, it } from "bun:test";
import { appendFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TeamStore } from "../src/team/team-store.ts";
import { hasBoardItemShape, JsonlFileBoardStorage } from "../src/team/todo.ts";

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

function makeDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "agency-board-"));
  dirs.push(dir);
  return dir;
}

describe("board persistence", () => {
  it("claims and statuses survive a restart round-trip", async () => {
    const dir = makeDir();
    const first = new TeamStore(undefined, { boardStorage: new JsonlFileBoardStorage(dir) });
    const team = first.create("ship x", "lead", {
      id: "team-persist",
      memberHandles: ["alice", "bob"],
    });
    const a = first.appendTodo(team.id, "implement x");
    const b = first.appendTodo(team.id, "write docs");
    expect(first.claimTodo(team.id, "alice", a.id)).toEqual({ ok: true });
    expect(first.setTodoStatus(team.id, "bob", b.id, "ready_for_review")).toEqual({ ok: true });
    await first.flushBoard(team.id);

    const second = new TeamStore(undefined, { boardStorage: new JsonlFileBoardStorage(dir) });
    second.create("ship x", "lead", { id: "team-persist", memberHandles: ["alice", "bob"] });
    expect(await second.restoreBoard("team-persist")).toBe(true);

    const items = second.listTodos("team-persist");
    expect(items.length).toBe(2);
    expect(items.find((item) => item.id === a.id)).toMatchObject({
      claimedBy: "alice",
      status: "in_progress",
    });
    expect(items.find((item) => item.id === b.id)).toMatchObject({ status: "ready_for_review" });
    expect(second.get("team-persist")?.sharedTodos).toEqual(items);

    const next = second.appendTodo("team-persist", "follow-up");
    expect(next.id).toBe("team-persist-todo-3");
    await second.flushBoard("team-persist");
  });

  it("claim/close/release invariants hold post-reload", async () => {
    const dir = makeDir();
    const first = new TeamStore(undefined, { boardStorage: new JsonlFileBoardStorage(dir) });
    const team = first.create("goal", "lead", { id: "team-rules", memberHandles: ["alice", "bob"] });
    const a = first.appendTodo(team.id, "guarded work");
    expect(first.claimTodo(team.id, "alice", a.id)).toEqual({ ok: true });
    await first.flushBoard(team.id);

    const second = new TeamStore(undefined, { boardStorage: new JsonlFileBoardStorage(dir) });
    second.create("goal", "lead", { id: "team-rules", memberHandles: ["alice", "bob"] });
    expect(await second.restoreBoard("team-rules")).toBe(true);

    expect(second.setTodoStatus(team.id, "alice", a.id, "completed")).toEqual({
      ok: false,
      reason: "cannot mark own claimed item completed; use ready_for_review",
    });
    expect(second.claimTodo(team.id, "bob", a.id)).toEqual({
      ok: false,
      reason: "already claimed by alice",
    });
    expect(second.releaseTodo(team.id, "bob", a.id)).toEqual({
      ok: false,
      reason: "not claimed by you",
    });
    expect(second.releaseTodo(team.id, "alice", a.id)).toEqual({ ok: true });
    expect(second.claimTodo(team.id, "bob", a.id)).toEqual({ ok: true });

    const fresh = second.appendTodo(team.id, "fresh work");
    expect(fresh.status).toBe("pending");
    expect(second.claimTodo(team.id, "bob", fresh.id)).toEqual({ ok: true });
    expect(second.listTodos(team.id).find((item) => item.id === fresh.id)?.status).toBe("in_progress");

    const solo = second.appendTodo(team.id, "solo work");
    expect(second.setTodoStatus(team.id, "bob", solo.id, "completed")).toEqual({ ok: true });
    const done = second.listTodos(team.id).find((item) => item.id === solo.id);
    expect(done?.status).toBe("completed");
    expect(done?.claimedBy).toBeUndefined();
    await second.flushBoard(team.id);
  });

  it("skips corrupt and wrong-shape lines with a warning, valid items intact", async () => {
    const dir = makeDir();
    const first = new TeamStore(undefined, { boardStorage: new JsonlFileBoardStorage(dir) });
    const team = first.create("goal", "lead", { id: "team-corrupt" });
    first.appendTodo(team.id, "good item");
    await first.flushBoard(team.id);

    const path = join(dir, "team-corrupt.board.jsonl");
    appendFileSync(
      path,
      `${[
        "not json at all",
        JSON.stringify({ id: "", content: "", status: "bogus" }),
        JSON.stringify({ id: "skewed", content: "future fields ride along", status: "pending", future: 1 }),
      ].join("\n")}\n`,
      "utf8",
    );

    const warns: string[] = [];
    const origWarn = console.warn;
    console.warn = (...args: unknown[]): void => {
      warns.push(String(args[0]));
    };
    let items: Array<{ id: string; content: string; status: string }> = [];
    try {
      const second = new TeamStore(undefined, { boardStorage: new JsonlFileBoardStorage(dir) });
      second.create("goal", "lead", { id: "team-corrupt" });
      expect(await second.restoreBoard("team-corrupt")).toBe(true);
      items = second.listTodos("team-corrupt");
    } finally {
      console.warn = origWarn;
    }

    expect(items.length).toBe(2);
    expect(items[0]?.content).toBe("good item");
    expect(items.find((item) => item.id === "skewed")?.status).toBe("pending");
    expect(warns.filter((w) => w.includes("skipped")).length).toBeGreaterThanOrEqual(2);
  });

  it("restoreBoard is false without a sidecar; delete removes the sidecar", async () => {
    const dir = makeDir();
    const teams = new TeamStore(undefined, { boardStorage: new JsonlFileBoardStorage(dir) });
    const team = teams.create("goal", "lead", { id: "team-gone" });
    expect(await teams.restoreBoard("missing-team")).toBe(false);
    teams.appendTodo(team.id, "ephemeral");
    await teams.flushBoard(team.id);
    expect(existsSync(join(dir, "team-gone.board.jsonl"))).toBe(true);

    teams.delete(team.id);
    await teams.flushBoard(team.id);
    expect(existsSync(join(dir, "team-gone.board.jsonl"))).toBe(false);
  });

  it("hasBoardItemShape accepts version-skew extras, rejects bad cores", () => {
    expect(hasBoardItemShape({ id: "a", content: "x", status: "pending", future: [1] })).toBe(true);
    expect(hasBoardItemShape({ id: "a", content: "x", status: "needs-user" })).toBe(true);
    expect(hasBoardItemShape({ content: "x", status: "pending" })).toBe(false);
    expect(hasBoardItemShape({ id: "a", content: "", status: "pending" })).toBe(false);
    expect(hasBoardItemShape({ id: "a", content: "x", status: "archived" })).toBe(false);
    expect(hasBoardItemShape({ id: "a", content: "x", status: "pending", claimedBy: 42 })).toBe(false);
    expect(hasBoardItemShape(null)).toBe(false);
  });
});
