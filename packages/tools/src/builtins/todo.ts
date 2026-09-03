import { t } from "@agency/i18n";
import type { ToolSpec } from "../contract.ts";
import { clip, itemCount, lineCount, summarize } from "../render.ts";

export type TodoStatus = "pending" | "in_progress" | "completed";

export interface TodoItem {
  id: string;
  content: string;
  status: TodoStatus;
}

/**
 * Session-scoped todo state, shared by both tools via closure: the run's
 * source of truth for multi-step task tracking. With a `persistence` hook the
 * store survives daemon restarts: writes append a `todo_state` session entry
 * (daemon-owned JSONL) and `hydrate` restores the latest one per session.
 */
export interface TodoPersistence {
  save: (sessionId: string, todos: readonly TodoItem[]) => Promise<void>;
  load: (sessionId: string) => readonly TodoItem[] | undefined | Promise<readonly TodoItem[] | undefined>;
}

export class TodoStore {
  items: TodoItem[] = [];

  constructor(private readonly persistence?: TodoPersistence) {}

  async replace(items: readonly TodoItem[], sessionId?: string): Promise<void> {
    this.items = [...items];
    if (sessionId !== undefined) await this.persistence?.save(sessionId, this.items);
  }

  /** Restores the session's persisted todos (clears when none were saved). */
  async hydrate(sessionId: string): Promise<void> {
    const loaded = await this.persistence?.load(sessionId);
    this.items = loaded ? [...loaded] : [];
  }
}

const STATUSES: ReadonlySet<string> = new Set(["pending", "in_progress", "completed"]);

/** Returns the first validation problem in a todo list, or undefined when it is well-formed. */
export function validateTodoItems(items: unknown): string | undefined {
  if (!Array.isArray(items)) return "items must be an array";
  const seen = new Set<string>();
  for (const [index, raw] of items.entries()) {
    if (typeof raw !== "object" || raw === null) return `items[${index}] must be an object`;
    const item = raw as Record<string, unknown>;
    if (typeof item.id !== "string" || item.id.length === 0) return `items[${index}].id must be a non-empty string`;
    if (typeof item.content !== "string" || item.content.trim().length === 0) {
      return `items[${index}].content must be a non-empty string`;
    }
    if (typeof item.status !== "string" || !STATUSES.has(item.status)) {
      return `items[${index}].status must be one of pending, in_progress, completed`;
    }
    if (seen.has(item.id)) return `items[${index}].id "${item.id}" is a duplicate`;
    seen.add(item.id);
  }
  return undefined;
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
      if (store.items.length === 0) return { content: t("tool.todo.empty") };
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

    async handler(input, ctx) {
      const problem = validateTodoItems(input.items);
      if (problem !== undefined) {
        return { content: t("tool.todo.invalid", { detail: problem }), isError: true };
      }

      try {
        await store.replace(input.items, ctx.sessionId);
      } catch (error) {
        // The in-memory update already landed; persistence is best-effort.
        return {
          content: `${t("tool.todo.updated", { count: input.items.length })} (persistence failed: ${
            error instanceof Error ? error.message : String(error)
          })`,
        };
      }
      return { content: t("tool.todo.updated", { count: input.items.length }) };
    },
  };
  return spec as unknown as ToolSpec;
}