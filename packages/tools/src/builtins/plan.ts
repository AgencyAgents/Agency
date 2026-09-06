import { createHash } from "node:crypto";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename } from "node:path";
import type { ToolDeps, ToolSpec } from "../contract.ts";
import { str, summarize } from "../render.ts";
import type { TodoItem, TodoStore } from "./todo.ts";

/** One GFM task-list entry in a plan file, in file order. */
export interface PlanStep {
  /** 1-based line the step appears on. */
  line: number;
  text: string;
  checked: boolean;
}

const TASK_ITEM = /^\s*[-*]\s+\[([ xX])\]\s+(.+)$/;

/**
 * Parses the GFM task list out of a plan file: `- [ ] step` /
 * `- [x] step` lines, in order. Everything else (prose, headings,
 * verification notes) is ignored.
 */
export function parsePlanSteps(markdown: string): PlanStep[] {
  const steps: PlanStep[] = [];
  const lines = markdown.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const match = TASK_ITEM.exec(lines[i] ?? "");
    const mark = match?.[1];
    const text = match?.[2];
    if (mark === undefined || text === undefined) continue;
    steps.push({ line: i + 1, text: text.trim(), checked: mark !== " " });
  }
  return steps;
}

export function planContentHash(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

/**
 * The plan_approval companion record: the plan file path, the content hash it
 * was approved against, and who approved it. The plan text itself is never
 * mutated by approval, so any later edit invalidates the hash automatically
 * and execution refuses a plan nobody actually approved in its current form.
 */
export interface PlanApprovalRecord {
  plan: string;
  hash: string;
  approvedBy: string;
  approvedAt: string;
}

export function approvalRecordPath(planPath: string): string {
  return `${planPath}.approval.json`;
}

/** Comments file placeholder consumed by the future inline-commenting UI (A2). */
export function commentsPath(planPath: string): string {
  return `${planPath}.comments.json`;
}

interface CommentsFile {
  comments?: Array<{ resolved?: boolean }>;
}

/** Typed fail-closed error for corrupt gate sidecars; never read as empty. */
export class PlanSidecarCorruptError extends Error {
  readonly sidecar: string;
  constructor(sidecar: string) {
    super(`corrupt plan sidecar: ${sidecar}`);
    this.name = "PlanSidecarCorruptError";
    this.sidecar = sidecar;
  }
}

/** How many comments are unresolved; throws PlanSidecarCorruptError when corrupt. */
export function countUnresolvedComments(planPath: string): number {
  const file = commentsPath(planPath);
  if (!existsSync(file)) return 0;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8")) as CommentsFile;
  } catch {
    throw new PlanSidecarCorruptError(file);
  }
  if (typeof parsed !== "object" || parsed === null) throw new PlanSidecarCorruptError(file);
  const comments = (parsed as CommentsFile).comments;
  if (comments === undefined) return 0;
  if (!Array.isArray(comments)) throw new PlanSidecarCorruptError(file);
  return comments.filter((c) => (typeof c === "object" && c !== null ? !c.resolved : true)).length;
}

export function readApprovalRecord(planPath: string): PlanApprovalRecord | undefined {
  const file = approvalRecordPath(planPath);
  if (!existsSync(file)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as PlanApprovalRecord;
    if (typeof parsed.hash === "string" && typeof parsed.approvedBy === "string") return parsed;
    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * Writes the plan_approval record after validating the gate: a plan with
 * unresolved comments cannot be approved into execution. Returns the record.
 */
export function writeApprovalRecord(
  planPath: string,
  options: { approvedBy?: string; content?: string } = {},
): PlanApprovalRecord {
  const unresolved = countUnresolvedComments(planPath);
  if (unresolved > 0) {
    throw new Error(
      `cannot approve plan: ${unresolved} unresolved comment(s): resolve them before approving`,
    );
  }
  const content = options.content ?? readFileSync(planPath, "utf8");
  const record: PlanApprovalRecord = {
    plan: planPath,
    hash: planContentHash(content),
    approvedBy: options.approvedBy ?? "user",
    approvedAt: new Date().toISOString(),
  };
  writeFileSync(approvalRecordPath(planPath), JSON.stringify(record, null, 2), "utf8");
  return record;
}

/** Sidecar file holding the plan review issues. */
export function reviewPath(planPath: string): string {
  return `${planPath}.review.json`;
}

/** Severity of one plan review issue, ordered info < low < high < critical. */
export type PlanIssueSeverity = "info" | "low" | "high" | "critical";

/** One review finding attached to a plan file. */
export interface PlanIssue {
  severity: PlanIssueSeverity;
  message: string;
  line?: number;
}

/** Machine readable gate outcome for downstream feedback wiring. */
export type PlanGateReason =
  | "pass-clean"
  | "pass-advisory-only"
  | "fail-blocking-severity"
  | "fail-unresolved-comments";

/** Gate decision: pass flag plus reason code and blocking issues. */
export interface PlanGateDecision {
  pass: boolean;
  reason: PlanGateReason;
  blocking: PlanIssue[];
  unresolved: number;
}

/** Severities that fail the gate; info and low are advisory only. */
export const PLAN_BLOCKING_SEVERITIES: readonly PlanIssueSeverity[] = ["high", "critical"];

/** True when the severity blocks execution (high or critical). */
export function isBlockingSeverity(severity: PlanIssueSeverity): boolean {
  return PLAN_BLOCKING_SEVERITIES.includes(severity);
}

const KNOWN_SEVERITIES: readonly string[] = ["info", "low", "high", "critical"];

/** True for a well formed review issue (known severity, non-empty message). */
function isPlanIssue(value: unknown): value is PlanIssue {
  if (typeof value !== "object" || value === null) return false;
  const v = value as { severity?: unknown; message?: unknown; line?: unknown };
  if (typeof v.severity !== "string" || !KNOWN_SEVERITIES.includes(v.severity)) return false;
  if (typeof v.message !== "string" || v.message.length === 0) return false;
  return v.line === undefined || typeof v.line === "number";
}

/** Read review issues, empty only when no review file exists. */
export function readPlanIssues(planPath: string): PlanIssue[] {
  const file = reviewPath(planPath);
  if (!existsSync(file)) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    throw new PlanSidecarCorruptError(file);
  }
  const list = Array.isArray(parsed) ? parsed : (parsed as { issues?: unknown }).issues;
  if (!Array.isArray(list)) throw new PlanSidecarCorruptError(file);
  return list.filter(isPlanIssue);
}

/** Replace the review issues held for a plan file. */
export function writePlanIssues(planPath: string, issues: PlanIssue[]): void {
  for (const issue of issues) {
    if (!isPlanIssue(issue)) throw new Error(`invalid plan issue: ${JSON.stringify(issue)}`);
  }
  writeFileSync(reviewPath(planPath), JSON.stringify({ issues }, null, 2), "utf8");
}

/** Evaluate the severity gate plus unresolved comments. */
export function evaluatePlanGate(planPath: string, issues?: PlanIssue[]): PlanGateDecision {
  const unresolved = countUnresolvedComments(planPath);
  if (unresolved > 0) return { pass: false, reason: "fail-unresolved-comments", blocking: [], unresolved };
  const list = issues ?? readPlanIssues(planPath);
  const blocking = list.filter((issue) => isBlockingSeverity(issue.severity));
  if (blocking.length > 0) return { pass: false, reason: "fail-blocking-severity", blocking, unresolved };
  if (list.length > 0) return { pass: true, reason: "pass-advisory-only", blocking: [], unresolved };
  return { pass: true, reason: "pass-clean", blocking: [], unresolved };
}

/** Stable plan id: file basename without the .md suffix. */
export function planIdForPath(planPath: string): string {
  const base = basename(planPath.replace(/\\/g, "/"));
  return base.endsWith(".md") ? base.slice(0, -3) : base;
}

/** One entry in the plan revision history sidecar. */
export interface PlanRevision {
  revision: number;
  hash: string;
  revisedAt: string;
  note?: string;
}

/** Sidecar file holding the revision history. */
export function revisionsPath(planPath: string): string {
  return `${planPath}.revisions.json`;
}

/** Read revision history, empty only when never revised. */
export function readPlanRevisions(planPath: string): PlanRevision[] {
  const file = revisionsPath(planPath);
  if (!existsSync(file)) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    throw new PlanSidecarCorruptError(file);
  }
  const list = Array.isArray(parsed) ? parsed : (parsed as { revisions?: unknown }).revisions;
  if (!Array.isArray(list)) throw new PlanSidecarCorruptError(file);
  return list.filter(
    (entry): entry is PlanRevision =>
      typeof entry === "object" &&
      entry !== null &&
      typeof (entry as PlanRevision).revision === "number" &&
      typeof (entry as PlanRevision).hash === "string",
  );
}

/** Rewrite plan content in place, preserving id, appending history. */
export function revisePlan(planPath: string, content: string, note?: string): PlanRevision {
  writeFileSync(planPath, content, "utf8");
  const history = readPlanRevisions(planPath);
  const entry: PlanRevision = {
    revision: history.length + 1,
    hash: planContentHash(content),
    revisedAt: new Date().toISOString(),
    ...(note === undefined ? {} : { note }),
  };
  writeFileSync(revisionsPath(planPath), JSON.stringify({ revisions: [...history, entry] }, null, 2), "utf8");
  return entry;
}

/** Re-hash current content and clear any stale approval. */
export function resubmitPlan(planPath: string): { hash: string; approvalReset: boolean } {
  const hash = planContentHash(readFileSync(planPath, "utf8"));
  const approvalFile = approvalRecordPath(planPath);
  const approvalReset = existsSync(approvalFile);
  if (approvalReset) rmSync(approvalFile, { force: true });
  return { hash, approvalReset };
}

/**
 * Plan presentation parity (opencode): the plan file lives at
 * `.opencode/plans/<epoch>-<slug>.md`, the plan agent may only edit plan
 * files, the 5-phase workflow is surfaced via SessionReminders, approval is
 * a plan_exit Yes/No question whose Yes synthesizes the build-agent message,
 * scrollback collapses plan blocks to an icon, and non-interactive runs
 * force-deny plan_exit/question. `.agency/plans/` is accepted as a legacy
 * alias wherever a plan path is checked.
 */

/** Canonical plan directory (opencode parity). */
export const PLAN_DIR = ".opencode/plans";

/** Legacy plan directory, still accepted by path checks and the gate. */
export const LEGACY_PLAN_DIR = ".agency/plans";

/** Working plan directory, redirected to the canonical dir. */
export const WORKING_PLAN_DIR = ".omo/plans";

/** Single-line scrollback marker for collapsed plan blocks. */
export const PLAN_BLOCK_ICON = "📋";

function normalizePlanSlashes(p: string): string {
  return p.replace(/\\/g, "/").replace(/\/{2,}/g, "/");
}

/** Lexically resolve `.` and `..` without touching the filesystem. */
function lexicalResolve(n: string): string {
  const parts = n.split("/");
  const out: string[] = [];
  for (const part of parts) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      const last = out[out.length - 1];
      if (last !== undefined && last !== "..") out.pop();
      else out.push("..");
    } else out.push(part);
  }
  return out.join("/");
}

const PLAN_DIRS: readonly string[][] = [
  [".opencode", "plans"],
  [".agency", "plans"],
  [".omo", "plans"],
];

/** True when lexically confined inside a plan directory (any spelling). */
export function isPlanPath(p: string): boolean {
  const n = normalizePlanSlashes(p);
  if (n.startsWith("/") || /^[A-Za-z]:\//.test(n)) return false;
  const resolved = lexicalResolve(n);
  if (resolved === ".." || resolved.startsWith("../")) return false;
  const segs = resolved.split("/").filter((s) => s.length > 0);
  return PLAN_DIRS.some((dir) => segs.some((s, i) => s === dir[0] && segs[i + 1] === dir[1]));
}

/** Lowercase, dash-separated slug for plan file names. */
export function slugifyPlanTitle(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
  return slug.length > 0 ? slug : "plan";
}

/**
 * Builds the canonical plan file path
 * `.opencode/plans/<epoch>-<slug>.md`. `titleOrSlug` may be a free-form
 * title (slugified) or an already-slugified id. `epoch` defaults to the
 * current unix seconds.
 */
export function planFilePath(titleOrSlug: string, epoch: number = Math.floor(Date.now() / 1000)): string {
  return `${PLAN_DIR}/${epoch}-${slugifyPlanTitle(titleOrSlug)}.md`;
}

/**
 * The plan agent's permission map: read-only everywhere except plan files.
 * Write/edit deny everything but `.opencode/plans/**` (plus the legacy
 * `.agency/plans/**` alias). Returns a fresh object per call so callers
 * cannot mutate the shared default.
 */
export function planAgentPermissions(): Record<string, unknown> {
  return {
    read: "allow",
    glob: "allow",
    grep: "allow",
    write: {
      "*": "deny",
      ".opencode/plans/**": "allow",
      ".agency/plans/**": "allow",
      ".omo/plans/**": "allow",
    },
    edit: {
      "*": "deny",
      ".opencode/plans/**": "allow",
      ".agency/plans/**": "allow",
      ".omo/plans/**": "allow",
    },
    bash: "deny",
    question: "allow",
    plan_exit: "allow",
    execute_plan: "deny",
  };
}

/** Collapsed one-line scrollback rendering for a plan block. */
export function renderPlanBlockForScrollback(planPath: string): string {
  return `${PLAN_BLOCK_ICON} plan ${planPath}`;
}

/**
 * Collapses a full plan markdown body to its icon line for scrollback:
 * history keeps the icon + path, not the whole draft.
 */
export function collapsePlanBlockForScrollback(_content: string, planPath: string): string {
  return renderPlanBlockForScrollback(planPath);
}

/** Exact synthetic build-agent message emitted on plan_exit approval. */
export function planApprovedMessage(plan: string): string {
  return `The plan at ${plan} has been approved, you can now edit files. Execute the plan`;
}

/** True for Yes answers to the plan_exit question (case-insensitive). */
export function isPlanExitYes(answer: string): boolean {
  const n = answer.trim().toLowerCase();
  return n === "yes" || n === "y" || n === "approve" || n === "approved";
}

/**
 * The plan_exit tool: presents the plan as a Yes/No question. A Yes writes
 * the plan_approval record and answers with the synthetic build-agent
 * message; a No declines without writing. Non-interactive runs (no approval
 * surface) force-deny, mirroring PermissionsGate's fail-closed rule.
 */
export function createPlanExitTool(deps: ToolDeps, opts: { nonInteractive?: boolean } = {}): ToolSpec {
  const spec: ToolSpec<{ plan: string; answer?: string }> = {
    name: "plan_exit",
    description:
      "Presents the plan file for approval as a Yes/No question. Answer Yes to approve " +
      "(writes the plan_approval record) or No to decline. After calling with no answer, " +
      "END YOUR TURN: the user's answer arrives as their next message.",
    inputSchema: {
      type: "object",
      properties: {
        plan: { type: "string", description: "Path to the plan file, e.g. .opencode/plans/123-slug.md" },
        answer: {
          type: "string",
          description: "Optional Yes/No answer when the user already replied.",
        },
      },
      required: ["plan"],
    },
    riskTier: "safe",
    renderCall: (input) => `${PLAN_BLOCK_ICON} plan_exit ${summarize(str(input.plan))}`,
    renderResult: (result) =>
      result.isError ? `plan_exit failed: ${summarize(result.content)}` : summarize(result.content),

    async handler(input, ctx) {
      if (opts.nonInteractive) {
        return {
          content: "plan_exit denied: non-interactive run has no approval surface",
          isError: true,
        };
      }
      const plan = str(input.plan).trim();
      if (plan.length === 0) {
        return { content: "plan_exit requires a non-empty plan path", isError: true };
      }
      const answer = typeof input.answer === "string" ? input.answer : undefined;
      if (answer === undefined) {
        const structured = JSON.stringify({
          type: "plan_exit",
          plan,
          question: `Approve the plan at ${plan}?`,
          choices: ["Yes", "No"],
        });
        return { content: `${structured}\n  1. Yes\n  2. No` };
      }
      if (!isPlanExitYes(answer)) {
        return { content: `plan at ${plan} not approved: revise the plan and ask again` };
      }
      const resolved = await deps.sandbox.resolvePathGated(plan, {
        tool: "plan_exit",
        ask: ctx.requestApproval,
      });
      try {
        writeApprovalRecord(resolved, { approvedBy: "user" });
      } catch (error) {
        return {
          content: error instanceof Error ? error.message : String(error),
          isError: true,
        };
      }
      return { content: planApprovedMessage(plan) };
    },
  };
  return spec as unknown as ToolSpec;
}

/** Approve & execute: approved plan hash matches, unchecked steps become todos. */
export function createExecutePlanTool(deps: ToolDeps, todos: TodoStore): ToolSpec {
  const spec: ToolSpec<{ path: string }> = {
    name: "execute_plan",
    description:
      "Executes an approved plan file (a markdown GFM task list). The plan must carry a matching " +
      "plan_approval record; editing the plan after approval invalidates it. Unchecked steps " +
      "become the todo list, in order.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path to the plan file, e.g. .opencode/plans/my-plan.md" },
      },
      required: ["path"],
    },
    riskTier: "moderate",
    renderCall: (input) => `execute_plan ${summarize(str(input.path))}`,
    renderResult: (result) =>
      result.isError ? `execute_plan failed: ${summarize(result.content)}` : summarize(result.content),

    async handler(input, ctx) {
      const resolved = await deps.sandbox.resolvePathGated(input.path, {
        tool: "execute_plan",
        ask: ctx.requestApproval,
      });

      let gate: PlanGateDecision;
      try {
        gate = evaluatePlanGate(resolved);
      } catch (error) {
        return {
          content: error instanceof Error ? error.message : String(error),
          isError: true,
        };
      }
      if (!gate.pass) {
        const detail =
          gate.reason === "fail-unresolved-comments"
            ? `${gate.unresolved} unresolved comment(s): resolve them before executing`
            : `blocking issue(s): ${gate.blocking.map((issue) => `[${issue.severity}] ${issue.message}`).join("; ")}`;
        return {
          content: `${input.path} blocked by plan gate [${gate.reason}]: ${detail}`,
          isError: true,
        };
      }

      const record = readApprovalRecord(resolved);
      if (!record) {
        return {
          content: `${input.path} has no plan_approval record: present the plan for approval before executing it`,
          isError: true,
        };
      }

      const content = readFileSync(resolved, "utf8");
      const hash = planContentHash(content);
      if (record.hash !== hash) {
        return {
          content: `${input.path} changed after it was approved (content hash mismatch): re-approve the current version before executing`,
          isError: true,
        };
      }

      const steps = parsePlanSteps(content).filter((step) => !step.checked);
      if (steps.length === 0) {
        return { content: `${input.path} has no unchecked steps: nothing to execute` };
      }

      const items: TodoItem[] = steps.map((step, index) => ({
        id: `plan-${index + 1}`,
        content: step.text,
        status: "pending",
      }));
      await todos.replace(items, ctx.sessionId);

      return {
        content: `plan approved by ${record.approvedBy}; queued ${items.length} step(s) as todos:\n${items
          .map((item) => `- ${item.content}`)
          .join("\n")}`,
      };
    },
  };
  return spec as unknown as ToolSpec;
}
