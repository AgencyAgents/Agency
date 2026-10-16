import type { Entry, Message } from "./types.ts";

export interface ToolStep {
  id: string;
  name: string;
  input: Record<string, unknown>;
  result?: string;
  isError?: boolean;
}

export type Part =
  | { kind: "text"; text: string }
  | { kind: "work"; steps: ToolStep[]; thinking: string[]; startedAt?: number; endedAt?: number }
  | { kind: "note"; text: string };

export interface Turn {
  key: string;
  prompt: string;
  images: number;
  note?: string;
  parts: Part[];
  startedAt?: number;
  endedAt?: number;
}

/** The entries from the root to `tipId`: a session file holds every branch, the view shows one. */
export function chain(entries: Entry[], tipId: string): Entry[] {
  const byId = new Map(entries.map((e) => [e.id, e]));
  const out: Entry[] = [];
  let cursor = byId.get(tipId);
  while (cursor) {
    out.push(cursor);
    cursor = cursor.parentId ? byId.get(cursor.parentId) : undefined;
  }
  return out.reverse();
}

function promptOf(message: Message): { text: string; images: number } | null {
  const texts = message.content.filter((b) => b.type === "text").map((b) => (b as { text: string }).text);
  if (texts.length === 0) return null;
  return { text: texts.join("\n"), images: message.content.filter((b) => b.type === "image").length };
}

function lastWork(turn: Turn): Extract<Part, { kind: "work" }> | undefined {
  const last = turn.parts.at(-1);
  return last?.kind === "work" ? last : undefined;
}

/** Adds one assistant message to a turn: text ends the work group before it, tool calls and thinking join one. */
export function addAssistant(turn: Turn, message: Message, at?: number): void {
  for (const block of message.content) {
    if (block.type === "text") {
      if (!block.text.trim()) continue;
      turn.parts.push({ kind: "text", text: block.text });
      continue;
    }
    if (block.type !== "tool_call" && block.type !== "thinking") continue;
    let work = lastWork(turn);
    if (!work) {
      const prev = turn.parts.at(-1);
      work = { kind: "work", steps: [], thinking: [], startedAt: prev ? at : turn.startedAt };
      turn.parts.push(work);
    }
    if (block.type === "thinking") {
      if (block.text.trim()) work.thinking.push(block.text);
    } else {
      work.steps.push({ id: block.id, name: block.name, input: block.input ?? {} });
    }
    if (at !== undefined) work.endedAt = at;
  }
}

function addResults(turn: Turn, message: Message, at?: number): void {
  for (const block of message.content) {
    if (block.type !== "tool_result") continue;
    for (const part of turn.parts) {
      if (part.kind !== "work") continue;
      const step = part.steps.find((s) => s.id === block.toolCallId);
      if (!step) continue;
      step.result = block.content;
      step.isError = block.isError ?? false;
      if (at !== undefined) part.endedAt = at;
    }
  }
}

export function buildTurns(entries: Entry[]): Turn[] {
  const turns: Turn[] = [];
  for (const entry of entries) {
    const at = Date.parse(entry.createdAt);
    const turn = turns.at(-1);
    if (entry.type === "compaction_summary") {
      turn?.parts.push({ kind: "note", text: "The conversation was compacted to free up context." });
      continue;
    }
    if (entry.type === "usage" && turn) {
      turn.endedAt = at;
      continue;
    }
    if (entry.type !== "message" || !entry.message) continue;
    const message = entry.message;
    if (message.role === "user") {
      const prompt = promptOf(message);
      if (prompt) {
        turns.push({ key: entry.id, prompt: prompt.text, images: prompt.images, parts: [], startedAt: at });
      } else if (turn) {
        addResults(turn, message, at);
      }
    } else if (message.role === "assistant" && turn) {
      addAssistant(turn, message, at);
    }
  }
  return turns;
}

const base = (p: unknown): string => {
  const s = typeof p === "string" ? p : "";
  return s.split(/[\\/]/).pop() || s;
};
const clip = (s: string, n = 90): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const str = (v: unknown): string => (typeof v === "string" ? v : "");

export type StepIcon = "read" | "search" | "edit" | "run" | "del" | "web" | "task" | "tool";

/** One line per tool call, in the words a person uses for it. */
export function describeStep(step: ToolStep): { icon: StepIcon; text: string; path?: string } {
  const i = step.input;
  const path = str(i.path ?? i.file_path ?? i.filePath);
  switch (step.name) {
    case "read":
      return { icon: "read", text: `Read ${base(path)}`, path };
    case "write":
      return { icon: "edit", text: `Wrote ${base(path)}`, path };
    case "edit":
    case "notebook_edit":
      return { icon: "edit", text: `Edited ${base(path)}`, path };
    case "bash":
      return { icon: "run", text: `Ran ${clip(str(i.command))}` };
    case "grep":
      return { icon: "search", text: `Searched for ${clip(str(i.pattern), 60)}` };
    case "glob":
      return { icon: "search", text: `Listed files matching ${clip(str(i.pattern), 60)}` };
    case "fetch":
      return { icon: "web", text: `Fetched ${clip(str(i.url), 70)}` };
    case "websearch":
      return { icon: "web", text: `Searched the web for ${clip(str(i.query), 60)}` };
    case "todo_write":
      return { icon: "task", text: "Updated the task list" };
    case "todo_read":
      return { icon: "task", text: "Read the task list" };
    case "spawn":
    case "dispatch":
    case "delegate":
    case "task":
      return {
        icon: "task",
        text: `Started a subagent: ${clip(str(i.description ?? i.prompt ?? i.goal), 60)}`,
      };
    default:
      return { icon: "tool", text: `Used ${step.name}` };
  }
}

export function stepIconPath(icon: StepIcon): string {
  return {
    read: "M13.5 3.5H7a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V9ZM13.5 3.5V9H19",
    search: "M11 17.5a6.5 6.5 0 1 0 0-13 6.5 6.5 0 0 0 0 13ZM20 20l-4-4",
    edit: "M16.5 4.5a2.1 2.1 0 0 1 3 3L8.5 18.5 4.5 19.5l1-4Z",
    run: "m6 8 4 4-4 4M12.5 16.5h6",
    del: "M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3",
    web: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM3.5 12h17M12 3c2.5 2.6 3.8 5.6 3.8 9s-1.3 6.4-3.8 9c-2.5-2.6-3.8-5.6-3.8-9S9.5 5.6 12 3Z",
    task: "M9 6h11M9 12h11M9 18h11M4.5 6h.01M4.5 12h.01M4.5 18h.01",
    tool: "M14.7 6.3a4 4 0 0 0-5.4 5.4L4 17l3 3 5.3-5.3a4 4 0 0 0 5.4-5.4l-2.6 2.6-2.4-.6-.6-2.4Z",
  }[icon];
}

export function duration(ms: number): string {
  const s = Math.max(1, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}

/** "Worked for 1m 02s", or "Working" while the group still runs. */
export function workLabel(part: Extract<Part, { kind: "work" }>, running: boolean): string {
  if (running) return "Working";
  if (part.startedAt !== undefined && part.endedAt !== undefined && part.endedAt > part.startedAt) {
    return `Worked for ${duration(part.endedAt - part.startedAt)}`;
  }
  return part.steps.length === 1 ? "1 step" : `${part.steps.length} steps`;
}
