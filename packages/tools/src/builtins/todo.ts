import type { ToolSpec } from "../contract.ts";
import { clip, itemCount, lineCount, summarize } from "../render.ts";

export type TodoStatus = "pending" | "in_progress" | "completed";

export interface TodoItem {
  id: string;
  content: string;
  status: TodoStatus;
}

/** Session-scoped todo state, shared by both tools via closure: the run's
 *  source of truth for multi-step task tracking (compaction-exempt once P5
 *  wires that up). */
export class TodoStore {
  items: TodoItem[] = [];
}

export function createTodoReadTool(store: TodoStore): ToolSpec {
  const spec: ToolSpec<Record<string, never>> = {
    name: "todo_read",
    description: "Reads the current todo list for this task.",
    inputSchema: { type: "object", properties: {} },
    riskTier: "safe",
    renderCall: () => "todo_read",
    renderResult: (result) => {
      if (result.isError) return `todo_read failed: ${summarize(result.content)}`;
      const trimmed = result.content.trim();
      if (trimmed === "" || trimmed === "(empty)") return "todo list is empty";
      return `todos: ${lineCount(result.content)} (${clip(result.content)})`;
    },

    async handler() {
      if (store.items.length === 0) return { content: "(empty)" };
      const lines = store.items.map((item) => `[${item.status}] ${item.content} (${item.id})`);
      return { content: lines.join("\n") };
    },
  };
  return spec as unknown as ToolSpec;
}

export function createTodoWriteTool(store: TodoStore): ToolSpec {
  const spec: ToolSpec<{ items: TodoItem[] }> = {
    name: "todo_write",
    description: "Replaces the todo list with the given items. Pass the full list each call, not a diff.",
    inputSchema: {
      type: "object",
      properties: {
        items: {
          type: "array",
          items: {
            type: "object",
            properties: {
              id: { type: "string" },
              content: { type: "string" },
              status: { type: "string", enum: ["pending", "in_progress", "completed"] },
            },
            required: ["id", "content", "status"],
          },
        },
      },
      required: ["items"],
    },
    riskTier: "safe",
    renderCall: (input) => `todo_write (${itemCount(input.items)} items)`,
    renderResult: (result) =>
      result.isError ? `todo_write failed: ${summarize(result.content)}` : summarize(result.content),

    async handler(input) {
      store.items = input.items;
      return { content: `updated ${input.items.length} todo item(s)` };
    },
  };
  return spec as unknown as ToolSpec;
}
