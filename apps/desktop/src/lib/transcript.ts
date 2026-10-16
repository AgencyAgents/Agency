import type { Entry, Message } from "./types.ts";

export interface ToolStep {
  id: string;
  name: string;
  input: Record<string, unknown>;
  result?: string;
  isError?: boolean;
}

/** One thing the model did inside a work group, in the order it happened. */
export type Activity = { kind: "thought"; text: string } | ({ kind: "tool" } & ToolStep);
export type Work = { kind: "work"; items: Activity[]; startedAt?: number; endedAt?: number };

/** note: a session event, such as a compaction. aside: the harness or a hook spoke mid-turn. said: a message sent mid-turn. */
export type Part =
  | { kind: "text"; text: string }
  | Work
  | { kind: "note"; text: string }
  | { kind: "aside"; label: string; text: string }
  | { kind: "said"; text: string };

const HOOK_CONTEXT = /^<hook-context>\n?([\s\S]*?)\n?<\/hook-context>$/;

/** From the turn's usage entry. The timing fields exist only on turns the daemon timed. */
export interface TurnStats {
  model: string;
  inputTokens: number;
  outputTokens: number;
  ttftMs?: number;
  streamMs?: number;
}

export interface Turn {
  key: string;
  prompt: string;
  images: number;
  note?: string;
  parts: Part[];
  startedAt?: number;
  endedAt?: number;
  stats?: TurnStats;
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

/** The chain with what each compaction replaced put back in front of it. A compaction starts a new root
 *  and copies the kept tail onto it, so the replaced entries plus the chain hold each message once. */
export function history(entries: Entry[], tipId: string): Entry[] {
  const out = chain(entries, tipId);
  const done = new Set<string>();
  for (let first = out[0]; first?.type === "compaction_summary" && !done.has(first.id); first = out[0]) {
    done.add(first.id);
    const ids = new Set(Array.isArray(first.replacedEntryIds) ? (first.replacedEntryIds as string[]) : []);
    out.unshift(...entries.filter((e) => ids.has(e.id)));
  }
  return out;
}

export const toolsOf = (work: Work): ToolStep[] =>
  work.items.filter((a): a is Extract<Activity, { kind: "tool" }> => a.kind === "tool");

function promptOf(message: Message): { text: string; images: number } | null {
  const texts = message.content.filter((b) => b.type === "text").map((b) => (b as { text: string }).text);
  if (texts.length === 0) return null;
  return { text: texts.join("\n"), images: message.content.filter((b) => b.type === "image").length };
}

/** The open work group at the end of `parts`, started at `at` when there is none. */
export function workAt(parts: Part[], at?: number): Work {
  const last = parts.at(-1);
  if (last?.kind === "work") return last;
  const work: Work = { kind: "work", items: [], startedAt: at };
  parts.push(work);
  return work;
}

/** Adds one assistant message to a turn: text ends the work group before it, tool calls and thinking join one. */
export function addAssistant(turn: Turn, message: Message, at?: number): void {
  for (const block of message.content) {
    if (block.type === "text") {
      if (block.text.trim()) turn.parts.push({ kind: "text", text: block.text });
      continue;
    }
    if (block.type !== "tool_call" && block.type !== "thinking") continue;
    if (block.type === "thinking" && !block.text.trim()) continue;
    const work = workAt(turn.parts, turn.parts.length ? at : turn.startedAt);
    work.items.push(
      block.type === "thinking"
        ? { kind: "thought", text: block.text }
        : { kind: "tool", id: block.id, name: block.name, input: block.input ?? {} },
    );
    if (at !== undefined) work.endedAt = at;
  }
}

function addResults(turn: Turn, message: Message, at?: number): void {
  for (const block of message.content) {
    if (block.type !== "tool_result") continue;
    for (const part of turn.parts) {
      if (part.kind !== "work") continue;
      const step = toolsOf(part).find((s) => s.id === block.toolCallId);
      if (!step) continue;
      step.result = block.content;
      step.isError = block.isError ?? false;
      if (at !== undefined) part.endedAt = at;
    }
  }
}

function statsOf(entry: Entry): TurnStats | undefined {
  if (!entry.usage) return undefined;
  const timing = entry.timing as { ttftMs?: number; streamMs?: number } | undefined;
  return {
    model: entry.model ?? "",
    inputTokens: entry.usage.inputTokens,
    outputTokens: entry.usage.outputTokens,
    ttftMs: timing?.ttftMs,
    streamMs: timing?.streamMs,
  };
}

export function buildTurns(entries: Entry[]): Turn[] {
  const turns: Turn[] = [];
  for (const entry of entries) {
    const at = Date.parse(entry.createdAt);
    const turn = turns.at(-1);
    if (entry.type === "compaction_summary") {
      turn?.parts.push({ kind: "note", text: "Earlier messages were summarized here to free up context." });
      continue;
    }
    if (entry.type === "usage" && turn) {
      turn.endedAt = at;
      turn.stats = statsOf(entry);
      continue;
    }
    if (entry.type !== "message" || !entry.message) continue;
    const message = entry.message;
    if (message.role === "user") {
      const prompt = promptOf(message);
      if (prompt && entry.origin === "harness") {
        turn?.parts.push({ kind: "aside", label: "Agency sent the turn back", text: prompt.text });
      } else if (prompt && entry.origin === "inbox") {
        const hook = HOOK_CONTEXT.exec(prompt.text);
        turn?.parts.push(
          hook
            ? { kind: "aside", label: "A hook added context", text: hook[1] ?? "" }
            : { kind: "said", text: prompt.text },
        );
      } else if (prompt) {
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
    case "plan_exit":
      return { icon: "task", text: "Presented a plan" };
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

const EDIT_TOOLS = new Set(["edit", "write", "notebook_edit"]);

export type DiffLine = { k: "+" | "-"; text: string };

/** The lines an edit or write call removes and adds, read from its input. */
export function diffLines(name: string, input: Record<string, unknown>): DiffLine[] {
  if (!EDIT_TOOLS.has(name)) return [];
  const hunks = Array.isArray(input.hunks)
    ? (input.hunks as { oldText?: string; newText?: string }[])
    : [{ oldText: str(input.oldText ?? input.old_string), newText: str(input.newText ?? input.new_string) }];
  // A text that ends in a newline has no line after it.
  const lines = (t: string) => t.replace(/\n$/, "").split("\n");
  const out: DiffLine[] = [];
  for (const h of hunks) {
    if (h.oldText) for (const text of lines(h.oldText)) out.push({ k: "-", text });
    if (h.newText) for (const text of lines(h.newText)) out.push({ k: "+", text });
  }
  if (typeof input.content === "string") for (const text of lines(input.content)) out.push({ k: "+", text });
  return out;
}

const count = (n: number, one: string, many: string): string => (n === 1 ? one : `${n} ${many}`);

/** "Ran 2 commands, edited App.tsx, read 3 files": what a finished group did, plus its line counts. */
export function summarize(work: Work): { text: string; added: number; removed: number } {
  // Kind to its distinct items, in the order each kind first ran.
  const kinds = new Map<string, Set<string>>();
  let added = 0;
  let removed = 0;
  for (const s of toolsOf(work)) {
    const d = describeStep(s);
    const [kind, item] =
      s.name === "bash"
        ? ["run", s.id]
        : EDIT_TOOLS.has(s.name)
          ? [s.name === "write" ? "write" : "edit", d.path ?? ""]
          : s.name === "read"
            ? ["read", d.path ?? ""]
            : d.icon === "search" || d.icon === "web"
              ? [d.icon, d.icon]
              : ["other", d.text.charAt(0).toLowerCase() + d.text.slice(1)];
    kinds.set(kind, (kinds.get(kind) ?? new Set()).add(item));
    for (const l of diffLines(s.name, s.input)) l.k === "+" ? added++ : removed++;
  }
  // Sets hold full paths: two index.ts files in different folders are two files.
  const files = (set: Set<string>) => (set.size === 1 ? base([...set][0]) : `${set.size} files`);
  const words: Record<string, (set: Set<string>) => string> = {
    run: (set) => `ran ${count(set.size, "a command", "commands")}`,
    edit: (set) => `edited ${files(set)}`,
    write: (set) => `wrote ${files(set)}`,
    read: (set) => `read ${files(set)}`,
    search: () => "searched code",
    web: () => "searched the web",
    other: (set) => [...set].slice(0, 2).join(", ") + (set.size > 2 ? `, and ${set.size - 2} more` : ""),
  };
  const text = [...kinds].map(([k, set]) => words[k]?.(set) ?? "").join(", ") || "Thought";
  return { text: text.charAt(0).toUpperCase() + text.slice(1), added, removed };
}

/** "Reading store.ts" for the step that runs now. */
export function activeLabel(step: ToolStep): string {
  const [verb = "", ...rest] = describeStep(step).text.split(" ");
  return [ING[verb] ?? verb, ...rest].join(" ");
}

const ING: Record<string, string> = {
  Read: "Reading",
  Wrote: "Writing",
  Edited: "Editing",
  Ran: "Running",
  Searched: "Searching",
  Listed: "Listing",
  Fetched: "Fetching",
  Used: "Using",
  Updated: "Updating",
  Started: "Starting",
};

/** The first line of a thought, without Markdown marks, for its collapsed row. */
export function peek(text: string, last = false): string {
  const lines = text
    .split("\n")
    .map((l) => l.replace(/[*_#`>]/g, "").trim())
    .filter(Boolean);
  return (last ? lines.at(-1) : lines[0]) ?? "";
}
