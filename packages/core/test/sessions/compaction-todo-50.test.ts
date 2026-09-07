import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApproximateTokenizer } from "@agency/providers";
import type { Message } from "@agency/schema";
import { compact, planCompaction } from "../../src/sessions/compaction.ts";
import { SessionStore } from "../../src/sessions/store.ts";

function userMsg(text: string): Message {
  return { role: "user", content: [{ type: "text", text }] };
}

describe("todo compaction parity (50)", () => {
  test("planCompaction carryForward holds every todo_state; summarize holds messages only", () => {
    const chain = [
      { id: "1", parentId: null, schemaVersion: 2, createdAt: "t1", type: "message", message: userMsg("a") },
      {
        id: "2",
        parentId: "1",
        schemaVersion: 2,
        createdAt: "t2",
        type: "todo_state",
        todos: [{ id: "t1", content: "do it", status: "in_progress", claimedBy: "h1", priority: "high" }],
      },
      { id: "3", parentId: "2", schemaVersion: 2, createdAt: "t3", type: "message", message: userMsg("b") },
      {
        id: "4",
        parentId: "3",
        schemaVersion: 2,
        createdAt: "t4",
        type: "todo_state",
        todos: [{ id: "t1", content: "do it", status: "completed", priority: "high" }],
      },
      { id: "5", parentId: "4", schemaVersion: 2, createdAt: "t5", type: "message", message: userMsg("c") },
    ];
    const plan = planCompaction(chain, 1);
    expect(plan.carryForward.map((e) => e.id)).toEqual(["2", "4", "5"]);
    expect(plan.summarize.map((e) => e.id)).toEqual(["1", "3"]);
    expect(plan.summarize.every((e) => e.type === "message")).toBe(true);
    expect(plan.carryForward.some((e) => e.type === "todo_state")).toBe(true);
  });

  test("compaction integration preserves todo_state with claimedBy+priority on the new tip", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agency-todo-compact-50-"));
    try {
      const store = new SessionStore(dir);
      const meta = store.create("s1");
      const tokenizer = createApproximateTokenizer(1);

      let parentId: string | null = null;
      const append = async (entry: { type: string } & Record<string, unknown>) => {
        const e = await store.append(meta.id, { ...entry, parentId });
        parentId = e.id;
        return e;
      };

      await append({ type: "message", message: userMsg("x".repeat(50)) });
      const todos = [
        { id: "t1", content: "ship P5", status: "in_progress", claimedBy: "h1", priority: "high" },
      ];
      await append({ type: "todo_state", todos });
      await append({ type: "message", message: userMsg("y".repeat(50)) });
      const last = await append({ type: "message", message: userMsg("z".repeat(50)) });

      const result = await compact(
        store,
        meta.id,
        last.id,
        tokenizer,
        { contextWindow: 100, proactiveRatio: 0.5 },
        async () => "summary of old messages",
        1,
      );
      expect(result.compacted).toBe(true);

      const entries = store.load(meta.id);
      const chain = store.chainFor(entries, result.tipId);
      const todoEntries = chain.filter((e) => e.type === "todo_state");
      expect(todoEntries.length).toBeGreaterThanOrEqual(1);
      const latest = todoEntries[todoEntries.length - 1] as unknown as { todos: unknown };
      expect(latest.todos).toEqual(todos);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("U8 target expansion folds messages but keeps every todo_state (sync approximate tokenizer)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agency-todo-compact-u8-"));
    try {
      const store = new SessionStore(dir);
      const meta = store.create("s1");
      const tokenizer = createApproximateTokenizer(1);

      let parentId: string | null = null;
      const append = async (entry: { type: string } & Record<string, unknown>) => {
        const e = await store.append(meta.id, { ...entry, parentId });
        parentId = e.id;
        return e;
      };

      const todosA = [{ id: "t1", content: "old task", status: "completed", priority: "high" }];
      const todosB = [
        { id: "t2", content: "live task", status: "in_progress", claimedBy: "h1", priority: "high" },
      ];
      await append({ type: "message", message: userMsg("a".repeat(95)) });
      await append({ type: "todo_state", todos: todosA });
      await append({ type: "message", message: userMsg("b".repeat(95)) });
      await append({ type: "todo_state", todos: todosB });
      for (let i = 0; i < 8; i++)
        await append({ type: "message", message: userMsg(`m${i}-`.padEnd(95, "x")) });
      const entries0 = store.load(meta.id);
      const tip0 = entries0[entries0.length - 1]?.id ?? "";
      const beforeTodos = store.chainFor(entries0, tip0).filter((e) => e.type === "todo_state");
      expect(beforeTodos).toHaveLength(2);

      let calls = 0;
      const result = await compact(
        store,
        meta.id,
        tip0,
        tokenizer,
        { contextWindow: 1000 },
        async (text) => {
          calls += 1;
          return `digest-${calls}-${text.slice(0, 40)}`;
        },
        8,
      );
      expect(result.compacted).toBe(true);
      expect(calls).toBeGreaterThanOrEqual(2);

      const entries = store.load(meta.id);
      const chain = store.chainFor(entries, result.tipId);
      const afterTodos = chain.filter((e) => e.type === "todo_state") as unknown as Array<{ todos: unknown }>;
      expect(afterTodos).toHaveLength(2);
      expect(afterTodos[0]?.todos).toEqual(todosA);
      expect(afterTodos[1]?.todos).toEqual(todosB);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
