import { describe, expect, test } from "bun:test";
import { createTodoReadTool, createTodoWriteTool, TodoStore } from "../../src/builtins/todo.ts";

const signal = new AbortController().signal;

describe("todo tools", () => {
  test("todo_read reports empty when nothing has been written", async () => {
    const store = new TodoStore();
    const read = createTodoReadTool(store);
    const result = await read.handler({}, { signal });
    expect(result.content).toBe("(empty)");
  });

  test("todo_write replaces the list and todo_read reflects it", async () => {
    const store = new TodoStore();
    const write = createTodoWriteTool(store);
    const read = createTodoReadTool(store);

    await write.handler({ items: [{ id: "1", content: "fix the bug", status: "in_progress" }] }, { signal });
    const result = await read.handler({}, { signal });

    expect(result.content).toContain("fix the bug");
    expect(result.content).toContain("in_progress");
  });

  test("todo_write fully replaces the list, not merges", async () => {
    const store = new TodoStore();
    const write = createTodoWriteTool(store);

    await write.handler({ items: [{ id: "1", content: "first", status: "pending" }] }, { signal });
    await write.handler({ items: [{ id: "2", content: "second", status: "pending" }] }, { signal });

    expect(store.items).toHaveLength(1);
    expect(store.items[0]!.id).toBe("2");
  });

  test("the two tools share state via the same store instance", async () => {
    const store = new TodoStore();
    const write = createTodoWriteTool(store);
    const read = createTodoReadTool(store);

    await write.handler({ items: [{ id: "1", content: "shared", status: "completed" }] }, { signal });

    expect((await read.handler({}, { signal })).content).toContain("shared");
  });
});
