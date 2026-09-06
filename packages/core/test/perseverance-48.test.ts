import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dispatchProgress, parsePlanChecklist } from "../src/progress/checklist.ts";
import { ProgressStore } from "../src/progress/store.ts";

const PLAN = [
  "# demo - Work Plan",
  "## Todos",
  "- [x] 1. First task",
  "- [ ] 2. Second task",
  "- [ ] 48. Progress persistent state: introduce timers",
  "## Final verification wave",
  "- [ ] F1. Audit",
  "- [x] F2. Quality",
  "## Commit strategy",
  "- [ ] ignored: not a column item",
].join("\n");

describe("plan-checklist parser", () => {
  test("splits TODOs/FINAL columns with labels, keys, and line numbers", () => {
    const parsed = parsePlanChecklist(PLAN);
    expect(parsed.todos.map((t) => t.key)).toEqual(["todos:1", "todos:2", "todos:48"]);
    expect(parsed.todos[0]?.checked).toBe(true);
    expect(parsed.todos[1]?.checked).toBe(false);
    expect(parsed.todos[1]?.title).toBe("Second task");
    expect(parsed.todos[1]?.line).toBe(4);
    expect(parsed.final.map((t) => t.key)).toEqual(["final:F1", "final:F2"]);
    expect(parsed.final[1]?.checked).toBe(true);
    expect(parsed.other).toHaveLength(1);
  });

  test("dispatch progress drives the queue in plan order", () => {
    const progress = dispatchProgress(parsePlanChecklist(PLAN));
    expect(progress.total).toBe(5);
    expect(progress.completed).toBe(2);
    expect(progress.pending).toBe(3);
    expect(progress.nextKey).toBe("todos:2");
    expect(progress.pendingKeys).toEqual(["todos:2", "todos:48", "final:F1"]);
    expect(progress.percent).toBeCloseTo(0.4);
  });

  test("empty plan is trivially complete", () => {
    const progress = dispatchProgress(parsePlanChecklist("# empty\nno boxes\n"));
    expect(progress.total).toBe(0);
    expect(progress.percent).toBe(1);
    expect(progress.nextKey).toBeUndefined();
  });
});

describe("ProgressStore persistent state", () => {
  function workRoot(): string {
    return mkdtempSync(join(tmpdir(), "agency-progress-"));
  }

  test("timers persist across restarts with live elapsed while running", () => {
    const root = workRoot();
    try {
      let now = 1_000_000;
      const a = new ProgressStore(root, { now: () => now });
      a.startTask("todos:2", { label: "2", title: "Second task", agent: "junior" });
      a.save();
      expect(existsSync(join(root, ".agency", "progress.json"))).toBe(true);

      now += 5_000;
      const b = new ProgressStore(root, { now: () => now });
      expect(b.getTask("todos:2")?.status).toBe("running");
      expect(b.elapsedMs("todos:2")).toBe(5_000);

      const done = b.completeTask("todos:2");
      expect(done.elapsed_ms).toBe(5_000);
      expect(done.ended_at).toBeDefined();
      b.save();

      const c = new ProgressStore(root, { now: () => now + 60_000 });
      expect(c.getTask("todos:2")?.status).toBe("completed");
      expect(c.elapsedMs("todos:2")).toBe(5_000);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("restart does not reset a running start timestamp", () => {
    const root = workRoot();
    try {
      const a = new ProgressStore(root, { now: () => 1000 });
      a.startTask("todos:48", { label: "48", title: "Progress" });
      a.save();
      const b = new ProgressStore(root, { now: () => 2000 });
      b.startTask("todos:48", { label: "48", title: "Progress" });
      expect(b.getTask("todos:48")?.started_at).toBe(new Date(1000).toISOString());
      expect(b.elapsedMs("todos:48")).toBe(1000);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("syncFromChecklist + nextDispatchable drive dispatch", () => {
    const root = workRoot();
    try {
      const store = new ProgressStore(root);
      const checklist = parsePlanChecklist(PLAN);
      const updated = store.syncFromChecklist(checklist);
      expect(updated).toContain("todos:1");
      expect(updated).toContain("final:F2");
      expect(store.getTask("todos:1")?.status).toBe("completed");
      // Head unchecked item with no claim is dispatchable.
      expect(store.nextDispatchable(checklist)).toBe("todos:2");
      // Once claimed (running), the dispatcher skips to the next free item.
      store.startTask("todos:2", { label: "2", title: "Second task" });
      expect(store.nextDispatchable(checklist)).toBe("todos:48");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("notepad learnings append creates dir + file", () => {
    const root = workRoot();
    try {
      const store = new ProgressStore(root, { now: () => Date.parse("2026-09-04T12:00:00.000Z") });
      const file = store.appendLearning("demo-plan", "shipped progress timers");
      expect(file).toBe(join(root, ".omo", "notepads", "demo-plan", "learnings.md"));
      const text = readFileSync(file, "utf8");
      expect(text).toContain("shipped progress timers");
      expect(text).toContain("2026-09-04");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("existing .omo/perseverance.json is imported, new state lands under .agency", () => {
    const root = workRoot();
    try {
      const legacy = {
        schema_version: 2,
        active_work_id: "w1",
        active_plan: "plan.md",
        works: { w1: { work_id: "w1", agent: "worker" } },
        task_sessions: {},
      };
      mkdirSync(join(root, ".omo"), { recursive: true });
      writeFileSync(join(root, ".omo", "perseverance.json"), JSON.stringify(legacy), "utf8");
      const store = new ProgressStore(root);
      store.startTask("todos:9", { label: "9", title: "Keep me" });
      store.save();
      const roundTripped = JSON.parse(readFileSync(join(root, ".agency", "progress.json"), "utf8")) as Record<
        string,
        unknown
      >;
      expect(roundTripped.active_work_id).toBe("w1");
      expect(roundTripped.works).toBeDefined();
      expect(
        ((roundTripped.task_sessions as Record<string, unknown>)["todos:9"] as Record<string, unknown>)
          .task_title,
      ).toBe("Keep me");
      expect(readFileSync(join(root, ".omo", "perseverance.json"), "utf8")).toBe(JSON.stringify(legacy));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("corrupt .omo/perseverance.json falls back to empty instead of throwing", () => {
    const root = workRoot();
    try {
      mkdirSync(join(root, ".omo"), { recursive: true });
      writeFileSync(join(root, ".omo", "perseverance.json"), "{not json", "utf8");
      const store = new ProgressStore(root);
      expect(store.getTask("todos:1")).toBeUndefined();
      expect(store.elapsedMs("todos:1")).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
