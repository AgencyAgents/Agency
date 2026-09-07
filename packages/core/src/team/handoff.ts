import { dispatchProgress, parsePlanChecklist } from "../progress/checklist.ts";
import { type PlanDispatchOptions, planDispatchBatch } from "./dispatch-core.ts";
import type { BoardItem, BoardStore } from "./todo.ts";

export interface SessionTodo {
  id: string;
  content: string;
  status: "pending" | "in_progress" | "completed";
}

export function todosToBoard(
  board: BoardStore,
  todos: readonly SessionTodo[],
  filedBy: string,
): { filed: string[]; refused: Array<{ id: string; reason: string }> } {
  const filed: string[] = [];
  const refused: Array<{ id: string; reason: string }> = [];
  for (const todo of todos) {
    if (todo.status === "completed") continue;
    const outcome = board.file({ id: todo.id, content: todo.content }, filedBy);
    if (outcome.ok) filed.push(outcome.item.id);
    else refused.push({ id: todo.id, reason: outcome.reason });
  }
  return { filed, refused };
}

export function boardToTodos(items: readonly BoardItem[]): SessionTodo[] {
  return items
    .filter(
      (item) => item.status === "pending" || item.status === "in_progress" || item.status === "needs-user",
    )
    .map((item) => ({
      id: item.id,
      content: item.content,
      status: item.status === "in_progress" ? "in_progress" : "pending",
    }));
}

export interface PlanGateLike {
  pass: boolean;
  reason: string;
}

export interface PlanStep {
  title: string;
  pathScope?: string[];
  acceptanceCriteria?: string;
}

export function planStepsToTasks(
  board: BoardStore,
  gate: PlanGateLike,
  steps: readonly PlanStep[],
  filedBy: string,
): { ok: true; ids: string[] } | { ok: false; reason: string } {
  if (!gate.pass) return { ok: false, reason: `plan gate blocks conversion: ${gate.reason}` };
  const ids: string[] = [];
  for (const [index, step] of steps.entries()) {
    const outcome = board.file(
      {
        id: `plan-${index + 1}`,
        content: step.title,
        ...(step.acceptanceCriteria === undefined ? {} : { acceptanceCriteria: step.acceptanceCriteria }),
        ...(step.pathScope === undefined ? {} : { pathScope: step.pathScope }),
      },
      filedBy,
    );
    if (!outcome.ok) return { ok: false, reason: outcome.reason };
    ids.push(outcome.item.id);
  }
  return { ok: true, ids };
}

export function planBoardBatch(
  items: readonly BoardItem[],
  opts: PlanDispatchOptions,
): ReturnType<typeof planDispatchBatch> {
  return planDispatchBatch(
    items.map((item) => ({ handle: item.claimedBy ?? item.filedBy ?? "", brief: item.content })),
    { ...opts },
  );
}

export function boardToPlanFile(items: readonly BoardItem[]): string {
  const lines = ["# Team board projection", "", "## Todos", ""];
  const todos = items.filter((item) => item.status !== "ready_for_review");
  const finals = items.filter((item) => item.status === "ready_for_review");
  todos.forEach((item, index) => {
    const mark = item.status === "completed" ? "x" : " ";
    lines.push(`- [${mark}] ${String(index + 1)}. ${item.content} (${item.id})`);
  });
  lines.push("", "## Final verification", "");
  finals.forEach((item, index) => {
    lines.push(`- [ ] F${String(index + 1)}. ${item.content} (${item.id})`);
  });
  return `${lines.join("\n")}\n`;
}

export function planFileToBoard(board: BoardStore, markdown: string, filedBy: string): string[] {
  const checklist = parsePlanChecklist(markdown);
  const picked: string[] = [];
  const byId = new Map(board.list().map((item) => [item.id, item]));
  for (const entry of [...checklist.todos, ...checklist.final]) {
    const match = /\(([^)]+)\)\s*$/.exec(entry.text);
    const id = match?.[1];
    if (id === undefined) continue;
    const item = byId.get(id);
    if (!item) continue;
    if (!entry.checked && item.status === "completed") {
      board.setStatus(filedBy, id, "pending");
      picked.push(id);
    } else if (entry.checked && item.status !== "completed") {
      board.setStatus(filedBy, id, "completed");
    }
  }
  return picked;
}

export function boardCompletion(items: readonly BoardItem[]): "complete" | "incomplete" {
  const open = items.some((item) => item.status === "pending" || item.status === "in_progress");
  return open ? "incomplete" : "complete";
}

export function progressOfBoard(items: readonly BoardItem[]): {
  total: number;
  done: number;
  review: number;
} {
  return {
    total: items.length,
    done: items.filter((item) => item.status === "completed").length,
    review: items.filter((item) => item.status === "ready_for_review").length,
  };
}

export function dispatchProgressOfBoard(items: readonly BoardItem[]): ReturnType<typeof dispatchProgress> {
  return dispatchProgress({
    todos: items
      .filter((item) => item.status !== "ready_for_review")
      .map((item, index) => ({
        line: index + 1,
        checked: item.status === "completed",
        section: "todos" as const,
        label: item.id,
        key: `todos:${item.id}`,
        title: item.content,
        text: item.content,
      })),
    final: [],
    other: [],
  });
}

export function teamStatusLine(items: readonly BoardItem[], costUsd: number): string {
  const progress = progressOfBoard(items);
  return `team ${String(progress.total)} items, ${String(progress.done)} done, ${String(progress.review)} in review, $${costUsd.toFixed(2)}`;
}
