import { describe, expect, test } from "bun:test";
import {
  createSessionTodoPersistence,
  createTodoReadTool,
  createTodoWriteTool,
  TodoStore,
  validateTodoItems,
} from "../../src/builtins/todo.ts";

const signal = new AbortController().signal;

describe("todo presentation parity (50)", () => {
  test("TodoItem accepts optional priority low|medium|high", () => {
    expect(
      validateTodoItems([
        { id: "1", content: "a", status: "pending" },
        { id: "2", content: "b", status: "in_progress", priority: "high" },
        { id: "3", content: "c", status: "completed", priority: "low" },
      ]),
    ).toBeUndefined();
  });

  test("full-replace validation: non-empty, enum, dupe, bad priority", () => {
    expect(validateTodoItems([{ id: "1", content: "  ", status: "pending" }])).toContain("content");
    expect(validateTodoItems([{ id: "", content: "x", status: "pending" }])).toContain("id");
    expect(validateTodoItems([{ id: "1", content: "x", status: "done" }])).toContain("status");
    expect(validateTodoItems([{ id: "1", content: "x", status: "pending", priority: "urgent" }])).toContain(
      "priority",
    );
    expect(
      validateTodoItems([
        { id: "1", content: "a", status: "pending" },
        { id: "1", content: "b", status: "pending" },
      ]),
    ).toContain("duplicate");
    expect(validateTodoItems("nope")).toContain("array");
  });

  test("todo_write persists priority through full replace", async () => {
    const store = new TodoStore();
    const write = createTodoWriteTool(store);
    const result = await write.handler(
      { items: [{ id: "1", content: "ship it", status: "pending", priority: "high" }] },
      { signal },
    );
    expect(result.isError).toBeFalsy();
    expect(store.items).toEqual([{ id: "1", content: "ship it", status: "pending", priority: "high" }]);
  });

  test("todo_write rejects bad priority and keeps the old list", async () => {
    const store = new TodoStore();
    const write = createTodoWriteTool(store);
    await write.handler({ items: [{ id: "1", content: "keep", status: "pending" }] }, { signal });
    const bad = await write.handler(
      { items: [{ id: "1", content: "x", status: "pending", priority: "now" }] },
      { signal },
    );
    expect(bad.isError).toBe(true);
    expect(store.items).toEqual([{ id: "1", content: "keep", status: "pending" }]);
  });

  test("render is single-line per frame", async () => {
    const store = new TodoStore();
    const write = createTodoWriteTool(store);
    const read = createTodoReadTool(store);
    await write.handler(
      {
        items: [
          { id: "1", content: "first", status: "pending", priority: "high" },
          { id: "2", content: "second", status: "in_progress" },
        ],
      },
      { signal },
    );
    const readSpec = read as unknown as {
      renderCall: (input: unknown) => string;
      renderResult: (result: { content: string; isError?: boolean }) => string;
    };
    const writeSpec = write as unknown as {
      renderCall: (input: unknown) => string;
      renderResult: (result: { content: string; isError?: boolean }) => string;
    };
    expect(readSpec.renderCall({})).not.toContain("\n");
    expect(writeSpec.renderCall({ items: [{ id: "1" }] })).not.toContain("\n");
    const ok = await read.handler({}, { signal });
    expect(writeSpec.renderResult({ content: "updated 2 todo item(s)" })).not.toContain("\n");
    expect(readSpec.renderResult(ok)).not.toContain("\n");
    expect(readSpec.renderResult({ content: "boom", isError: true })).toContain("todo_read failed");
    expect(writeSpec.renderResult({ content: "bad", isError: true })).toContain("todo_write failed");
  });
});

describe("TodoPersistence save/load reverse-scan (50)", () => {
  function memoryStore() {
    const entries: Array<{ sid: string; type: string; todos?: unknown }> = [];
    return {
      entries,
      store: {
        load: (sid: string) => entries.filter((e) => e.sid === sid).map(({ sid: _s, ...rest }) => rest),
        latestTip: (es: Array<{ type: string }>) => (es.length > 0 ? `tip-${es.length}` : undefined),
        append: async (sid: string, entry: { type: string; parentId: string | null; todos: unknown }) => {
          expect(sid).toBe("s1");
          expect(entry.type).toBe("todo_state");
          entries.push({ sid, type: entry.type, todos: entry.todos });
          return { id: `e${entries.length}` };
        },
      },
    };
  }

  test("save appends todo_state; load reverse-scans to the latest", async () => {
    const { store } = memoryStore();
    const persistence = createSessionTodoPersistence(store);
    expect(persistence.load("s1")).toBeUndefined();
    await persistence.save("s1", [{ id: "1", content: "v1", status: "pending" }]);
    await persistence.save("s1", [
      { id: "1", content: "v2", status: "in_progress", priority: "high" },
      { id: "2", content: "new", status: "pending" },
    ]);
    const loaded = persistence.load("s1");
    expect(loaded).toEqual([
      { id: "1", content: "v2", status: "in_progress", priority: "high" },
      { id: "2", content: "new", status: "pending" },
    ]);
  });

  test("TodoStore hydrate restores the latest persisted list and clears when none", async () => {
    const { store } = memoryStore();
    const persistence = createSessionTodoPersistence(store);
    const todos = new TodoStore(persistence);
    await todos.replace([{ id: "1", content: "a", status: "pending" }], "s1");
    todos.items = [];
    await todos.hydrate("s1");
    expect(todos.items).toEqual([{ id: "1", content: "a", status: "pending" }]);
    await todos.hydrate("missing");
    expect(todos.items).toEqual([]);
  });
});
