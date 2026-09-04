import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
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

/** How many comments on this plan are still unresolved, 0 when none/absent. */
export function countUnresolvedComments(planPath: string): number {
  const file = commentsPath(planPath);
  if (!existsSync(file)) return 0;
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as CommentsFile;
    return (parsed.comments ?? []).filter((c) => !c.resolved).length;
  } catch {
    return 0;
  }
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
      `cannot approve plan: ${unresolved} unresolved comment(s) — resolve them before approving`,
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

/** Single-line scrollback marker for collapsed plan blocks. */
export const PLAN_BLOCK_ICON = "📋";

function normalizePlanSlashes(p: string): string {
  return p.replace(/\\/g, "/");
}

/** True when `p` points inside a plan directory (either spelling). */
export function isPlanPath(p: string): boolean {
  const n = normalizePlanSlashes(p);
  return (
    n === PLAN_DIR ||
    n === LEGACY_PLAN_DIR ||
    n.startsWith(`${PLAN_DIR}/`) ||
    n.startsWith(`${LEGACY_PLAN_DIR}/`) ||
    n.includes(`/${PLAN_DIR}/`) ||
    n.includes(`/${LEGACY_PLAN_DIR}/`)
  );
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
    write: { "*": "deny", ".opencode/plans/**": "allow", ".agency/plans/**": "allow" },
    edit: { "*": "deny", ".opencode/plans/**": "allow", ".agency/plans/**": "allow" },
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
      "END YOUR TURN — the user's answer arrives as their next message.",
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
        return { content: `plan at ${plan} not approved — revise the plan and ask again` };
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
        path: { type: "string", description: "Path to the plan file, e.g. .agency/plans/my-plan.md" },
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

      const record = readApprovalRecord(resolved);
      if (!record) {
        return {
          content: `${input.path} has no plan_approval record — present the plan for approval before executing it`,
          isError: true,
        };
      }

      const content = readFileSync(resolved, "utf8");
      const hash = planContentHash(content);
      if (record.hash !== hash) {
        return {
          content: `${input.path} changed after it was approved (content hash mismatch) — re-approve the current version before executing`,
          isError: true,
        };
      }

      const steps = parsePlanSteps(content).filter((step) => !step.checked);
      if (steps.length === 0) {
        return { content: `${input.path} has no unchecked steps — nothing to execute` };
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
