import { describe, expect, test } from "bun:test";
import type { TodoItem, TodoPersistence } from "../../src/builtins/todo.ts";
import {
  createTodoReadTool,
  createTodoWriteTool,
  TodoStore,
  validateTodoItems,
} from "../../src/builtins/todo.ts";

const signal = new AbortController().signal;

describe("todo_write validation (A6)", () => {
  test("well-formed lists pass validateTodoItems", () => {
    expect(validateTodoItems([{ id: "1", content: "do the thing", status: "pending" }])).toBeUndefined();
  });

  test("rejects empty content, bad status, duplicates, and non-objects", () => {
    expect(validateTodoItems([{ id: "1", content: "  ", status: "pending" }])).toContain("content");
    expect(validateTodoItems([{ id: "1", content: "x", status: "done" }])).toContain("status");
    expect(
      validateTodoItems([
        { id: "1", content: "a", status: "pending" },
        { id: "1", content: "b", status: "pending" },
      ]),
    ).toContain("duplicate");
    expect(validateTodoItems([{ id: "", content: "x", status: "pending" }])).toContain("id");
    expect(validateTodoItems("nope")).toContain("array");
  });

  test("the tool returns a clean error result and keeps the old list", async () => {
    const store = new TodoStore();
    const write = createTodoWriteTool(store);
    await write.handler({ items: [{ id: "1", content: "keep", status: "pending" }] }, { signal });

    const bad = await write.handler({ items: [{ id: "1", content: "", status: "pending" }] }, { signal });
    expect(bad.isError).toBe(true);
    expect(store.items).toHaveLength(1);
    expect(store.items[0]!.content).toBe("keep");
  });
});

describe("TodoStore persistence (A6)", () => {
  test("replace persists with the session id; hydrate restores the saved list", async () => {
    const saved = new Map<string, TodoItem[]>();
    const persistence: TodoPersistence = {
      save: async (sessionId, todos) => {
        saved.set(sessionId, [...todos]);
      },
      load: (sessionId) => saved.get(sessionId),
    };
    const store = new TodoStore(persistence);

    await store.replace([{ id: "1", content: "persisted", status: "in_progress" }], "ses-1");
    expect(saved.get("ses-1")).toHaveLength(1);

    store.items = [];
    await store.hydrate("ses-1");
    expect(store.items).toEqual([{ id: "1", content: "persisted", status: "in_progress" }]);

    await store.hydrate("ses-2");
    expect(store.items).toEqual([]);
  });

  test("the write tool persists through ctx.sessionId", async () => {
    const persisted: Array<{ sessionId: string; count: number }> = [];
    const persistence: TodoPersistence = {
      save: async (sessionId, todos) => {
        persisted.push({ sessionId, count: todos.length });
      },
      load: () => undefined,
    };
    const store = new TodoStore(persistence);
    const write = createTodoWriteTool(store);
    await write.handler(
      { items: [{ id: "1", content: "a", status: "pending" }] },
      { signal, sessionId: "ses-9" },
    );
    expect(persisted).toEqual([{ sessionId: "ses-9", count: 1 }]);

    await write.handler({ items: [{ id: "1", content: "a", status: "pending" }] }, { signal });
    expect(persisted).toHaveLength(1);
  });

  test("read reflects the empty marker after a cleared store", async () => {
    const store = new TodoStore();
    const read = createTodoReadTool(store);
    expect((await read.handler({}, { signal })).content).toBe("(empty)");
  });
});
