/**
 * Plan-checklist parser for Progress persistent state (item 48).
 *
 * Plan files carry two checkbox columns:
 * - `## Todos` — the numbered dispatch queue (`- [ ] 1. title`, `- [x] 2. ...`)
 * - `## Final ...` (e.g. `## Final verification wave`) — the F-gate queue
 *   (`- [ ] F1. ...`).
 *
 * Everything else (TL;DR, scope, strategy) is ignored. Parsing is purely
 * textual so dispatch progress can be derived without executing anything.
 */

export type ChecklistSection = "todos" | "final" | "other";

export interface ChecklistItem {
  /** 1-based source line. */
  line: number;
  /** Raw checkbox state. */
  checked: boolean;
  /** Section the item appeared under. */
  section: ChecklistSection;
  /** Leading label when present (`1`, `F2`, `todo:3`); otherwise "". */
  label: string;
  /** Stable dispatch key: `todo:<label>` for todos, `final:<label>` for final. */
  key: string;
  /** Human title with the label prefix stripped. */
  title: string;
  /** Full checkbox text as written. */
  text: string;
}

export interface PlanChecklist {
  todos: ChecklistItem[];
  final: ChecklistItem[];
  other: ChecklistItem[];
}

const HEADING = /^(#{1,6})\s+(.+?)\s*$/;
const TASK_ITEM = /^\s*[-*]\s+\[([ xX])\]\s+(.+)$/;
const LABEL_PREFIX = /^([A-Za-z]*\d+)\s*[.)\-:]\s+(.+)$/;

function classifyHeading(text: string): ChecklistSection {
  const lower = text.trim().toLowerCase();
  if (lower === "todos" || lower === "todo" || lower.startsWith("todo")) return "todos";
  if (lower.startsWith("final")) return "final";
  return "other";
}

function toKey(section: ChecklistSection, label: string, index: number): string {
  if (label) return `${section}:${label}`;
  return `${section}:#${index + 1}`;
}

/**
 * Parses the checkbox columns out of a plan markdown file. Items keep file
 * order within their section; headings re-classify the active section.
 */
export function parsePlanChecklist(markdown: string): PlanChecklist {
  const result: PlanChecklist = { todos: [], final: [], other: [] };
  let section: ChecklistSection = "other";
  const counters = { todos: 0, final: 0, other: 0 };
  const lines = markdown.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const heading = HEADING.exec(line);
    if (heading?.[2] !== undefined) {
      section = classifyHeading(heading[2]);
      continue;
    }
    const task = TASK_ITEM.exec(line);
    const mark = task?.[1];
    const text = task?.[2];
    if (mark === undefined || text === undefined) continue;
    const trimmed = text.trim();
    const labeled = LABEL_PREFIX.exec(trimmed);
    const label = labeled?.[1] !== undefined ? labeled[1] : "";
    const title = labeled?.[2] !== undefined ? labeled[2].trim() : trimmed;
    const item: ChecklistItem = {
      line: i + 1,
      checked: mark !== " ",
      section,
      label,
      key: toKey(section, label, counters[section]),
      title,
      text: trimmed,
    };
    counters[section] += 1;
    result[section].push(item);
  }
  return result;
}

export interface DispatchProgress {
  total: number;
  completed: number;
  pending: number;
  /** 0..1 fraction; 1 when there is nothing to do. */
  percent: number;
  /** First unchecked key in file order (todos then final), if any. */
  nextKey: string | undefined;
  /** Unchecked keys in file order (todos then final). */
  pendingKeys: string[];
}

/**
 * Dispatch driver: folds the two columns into one queue (todos first, then
 * final) so the dispatcher always picks the next unchecked item in plan
 * order. Survives plan edits because it keys off parsed labels, not indices.
 */
export function dispatchProgress(checklist: PlanChecklist): DispatchProgress {
  const ordered = [...checklist.todos, ...checklist.final];
  const pendingKeys = ordered.filter((item) => !item.checked).map((item) => item.key);
  const total = ordered.length;
  const pending = pendingKeys.length;
  const completed = total - pending;
  return {
    total,
    completed,
    pending,
    percent: total === 0 ? 1 : completed / total,
    nextKey: pendingKeys[0],
    pendingKeys,
  };
}
