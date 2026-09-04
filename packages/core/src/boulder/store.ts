import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { dispatchProgress, type PlanChecklist } from "./checklist.ts";

export const BOULDER_SCHEMA_VERSION = 2;
export const BOULDER_FILE = "boulder.json";

export type BoulderTaskStatus = "running" | "completed" | "failed";

export interface BoulderTask {
  task_key: string;
  task_label: string;
  task_title: string;
  session_id?: string;
  agent?: string;
  category?: string;
  status: BoulderTaskStatus;
  started_at: string;
  updated_at: string;
  ended_at?: string;
  elapsed_ms?: number;
}

/** On-disk shape. Unknown top-level/work fields are preserved verbatim so
 *  existing `.omo/boulder.json` state (works, session_ids, agent, ...) is
 *  never clobbered by a load/save round-trip. */
export interface BoulderFile {
  schema_version: number;
  active_plan?: string;
  plan_name?: string;
  status?: string;
  started_at?: string;
  updated_at?: string;
  task_sessions: Record<string, BoulderTask>;
  [key: string]: unknown;
}

function emptyFile(): BoulderFile {
  const now = new Date().toISOString();
  return { schema_version: BOULDER_SCHEMA_VERSION, started_at: now, updated_at: now, task_sessions: {} };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeTask(key: string, raw: unknown): BoulderTask | undefined {
  if (!isRecord(raw)) return undefined;
  const started = typeof raw.started_at === "string" ? (raw.started_at as string) : undefined;
  if (!started) return undefined;
  const status = raw.status;
  const normalized: BoulderTask = {
    task_key: typeof raw.task_key === "string" ? (raw.task_key as string) : key,
    task_label: typeof raw.task_label === "string" ? (raw.task_label as string) : key,
    task_title: typeof raw.task_title === "string" ? (raw.task_title as string) : "",
    status: status === "completed" || status === "failed" ? status : "running",
    started_at: started,
    updated_at: typeof raw.updated_at === "string" ? (raw.updated_at as string) : started,
  };
  if (typeof raw.session_id === "string") normalized.session_id = raw.session_id as string;
  if (typeof raw.agent === "string") normalized.agent = raw.agent as string;
  if (typeof raw.category === "string") normalized.category = raw.category as string;
  if (typeof raw.ended_at === "string") normalized.ended_at = raw.ended_at as string;
  if (typeof raw.elapsed_ms === "number") normalized.elapsed_ms = raw.elapsed_ms as number;
  return normalized;
}

/**
 * Persistent Boulder orchestration state rooted at `<workspace>/.omo`.
 *
 * - State file: `.omo/boulder.json` (atomic temp+rename writes, tolerant
 *   reads: missing/corrupt parses fall back to empty without throwing).
 * - Per-plan scratch: `.omo/notepads/<plan>/` (learnings.md append helper).
 * - Elapsed timers: `startTask` stamps `started_at`; `completeTask`/`failTask`
 *   stamp `ended_at` + `elapsed_ms`; `elapsedMs` reports live time for
 *   running tasks so restarts resume from the persisted start, not zero.
 */
export class BoulderStore {
  readonly workspaceRoot: string;
  private readonly now: () => number;
  private state: BoulderFile;

  constructor(workspaceRoot: string, opts?: { now?: () => number }) {
    this.workspaceRoot = workspaceRoot;
    this.now = opts?.now ?? Date.now;
    this.state = this.read();
  }

  boulderPath(): string {
    return join(this.workspaceRoot, ".omo", BOULDER_FILE);
  }

  notepadDir(plan: string): string {
    return join(this.workspaceRoot, ".omo", "notepads", plan);
  }

  learningsPath(plan: string): string {
    return join(this.notepadDir(plan), "learnings.md");
  }

  /** Current in-memory snapshot (live reference; mutate via task methods). */
  snapshot(): BoulderFile {
    return this.state;
  }

  /** Re-reads from disk, replacing in-memory state. Survives restarts: a
   *  fresh instance over the same root sees every previously saved timer. */
  reload(): BoulderFile {
    this.state = this.read();
    return this.state;
  }

  private read(): BoulderFile {
    const file = this.boulderPath();
    if (!existsSync(file)) return emptyFile();
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
      if (!isRecord(parsed)) return emptyFile();
      const next: BoulderFile = {
        ...(parsed as object),
        schema_version: BOULDER_SCHEMA_VERSION,
      } as BoulderFile;
      const rawSessions = isRecord(parsed.task_sessions)
        ? (parsed.task_sessions as Record<string, unknown>)
        : {};
      const sessions: Record<string, BoulderTask> = {};
      for (const [key, raw] of Object.entries(rawSessions)) {
        const task = normalizeTask(key, raw);
        if (task) sessions[key] = { ...(raw as object), ...task } as BoulderTask;
      }
      // Legacy top-level `task_sessions` absent but nested `works.<id>.task_sessions`
      // present (orchestrator shape): mirror the active work's sessions up so
      // dispatch progress works without migrating the file.
      if (Object.keys(sessions).length === 0 && isRecord(parsed.works)) {
        const works = parsed.works as Record<string, unknown>;
        const activeId = typeof parsed.active_work_id === "string" ? (parsed.active_work_id as string) : "";
        const candidates = [works[activeId], ...Object.values(works)];
        for (const work of candidates) {
          if (!isRecord(work)) continue;
          const nested = isRecord(work.task_sessions)
            ? (work.task_sessions as Record<string, unknown>)
            : undefined;
          if (!nested) continue;
          for (const [key, raw] of Object.entries(nested)) {
            const task = normalizeTask(key, raw);
            if (task) sessions[key] = { ...(raw as object), ...task } as BoulderTask;
          }
          if (Object.keys(sessions).length > 0) break;
        }
      }
      next.task_sessions = sessions;
      return next;
    } catch {
      return emptyFile();
    }
  }

  /** Atomic persist: write temp file in the same dir, then rename. */
  save(): void {
    const file = this.boulderPath();
    mkdirSync(join(file, ".."), { recursive: true });
    this.state.updated_at = new Date(this.now()).toISOString();
    this.state.schema_version = BOULDER_SCHEMA_VERSION;
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.state, null, 2), "utf8");
    renameSync(tmp, file);
  }

  getTask(key: string): BoulderTask | undefined {
    return this.state.task_sessions[key];
  }

  /** Starts (or restarts) a task timer. Idempotent start while running keeps
   *  the original `started_at` so elapsed time is not reset by a restart. */
  startTask(
    key: string,
    details: { label?: string; title?: string; sessionId?: string; agent?: string; category?: string } = {},
  ): BoulderTask {
    const existing = this.state.task_sessions[key];
    const at = new Date(this.now()).toISOString();
    if (existing && existing.status === "running") {
      existing.updated_at = at;
      if (details.title !== undefined) existing.task_title = details.title;
      return existing;
    }
    const task: BoulderTask = {
      task_key: key,
      task_label: details.label ?? existing?.task_label ?? key,
      task_title: details.title ?? existing?.task_title ?? "",
      status: "running",
      started_at: at,
      updated_at: at,
    };
    if (details.sessionId !== undefined) task.session_id = details.sessionId;
    if (details.agent !== undefined) task.agent = details.agent;
    if (details.category !== undefined) task.category = details.category;
    delete (task as { ended_at?: string }).ended_at;
    delete (task as { elapsed_ms?: number }).elapsed_ms;
    this.state.task_sessions[key] = task;
    return task;
  }

  private finish(key: string, status: "completed" | "failed"): BoulderTask {
    const existing = this.state.task_sessions[key] ?? this.startTask(key);
    const atMs = this.now();
    const startedMs = Date.parse(existing.started_at);
    existing.status = status;
    existing.ended_at = new Date(atMs).toISOString();
    existing.updated_at = existing.ended_at;
    existing.elapsed_ms = Number.isNaN(startedMs) ? 0 : Math.max(0, atMs - startedMs);
    return existing;
  }

  completeTask(key: string): BoulderTask {
    return this.finish(key, "completed");
  }

  failTask(key: string): BoulderTask {
    return this.finish(key, "failed");
  }

  /**
   * Elapsed wall-clock ms for a task: frozen `elapsed_ms` once finished,
   * live `now - started_at` while running (so it survives restarts), 0 for
   * unknown keys or unparseable timestamps.
   */
  elapsedMs(key: string, nowMs: number = this.now()): number {
    const task = this.state.task_sessions[key];
    if (!task) return 0;
    if (task.status !== "running") return task.elapsed_ms ?? 0;
    const startedMs = Date.parse(task.started_at);
    if (Number.isNaN(startedMs)) return 0;
    return Math.max(0, nowMs - startedMs);
  }

  /** Marks every checklist item already checked in the plan as completed in
   *  state (no-op for items already finished), returns the keys updated. */
  syncFromChecklist(checklist: PlanChecklist): string[] {
    const updated: string[] = [];
    for (const item of [...checklist.todos, ...checklist.final]) {
      if (!item.checked) continue;
      const existing = this.state.task_sessions[item.key];
      if (existing && existing.status !== "running") continue;
      if (existing) this.finish(item.key, "completed");
      else {
        const at = new Date(this.now()).toISOString();
        this.state.task_sessions[item.key] = {
          task_key: item.key,
          task_label: item.label,
          task_title: item.title,
          status: "completed",
          started_at: at,
          updated_at: at,
          ended_at: at,
          elapsed_ms: 0,
        };
      }
      updated.push(item.key);
    }
    return updated;
  }

  /**
   * Next dispatchable key: first unchecked checklist item (todos before
   * final) whose task is neither running nor finished. Undefined when the
   * queue is drained or the head is already claimed.
   */
  nextDispatchable(checklist: PlanChecklist): string | undefined {
    const progress = dispatchProgress(checklist);
    for (const key of progress.pendingKeys) {
      const task = this.state.task_sessions[key];
      if (!task || task.status === "failed") return key;
    }
    return undefined;
  }

  ensureNotepad(plan: string): string {
    const dir = this.notepadDir(plan);
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  /** Appends a timestamped entry to `.omo/notepads/<plan>/learnings.md`,
   *  creating the notepad dir and file on first use. */
  appendLearning(plan: string, entry: string): string {
    const dir = this.ensureNotepad(plan);
    const file = join(dir, "learnings.md");
    const stamp = new Date(this.now()).toISOString().slice(0, 10);
    const block = `\n## ${stamp} — Boulder\n\n${entry.trim()}\n`;
    const existing = existsSync(file) ? readFileSync(file, "utf8") : "# Learnings\n";
    const base = existing.endsWith("\n") ? existing : `${existing}\n`;
    writeFileSync(file, `${base}${block}`, "utf8");
    return file;
  }
}
