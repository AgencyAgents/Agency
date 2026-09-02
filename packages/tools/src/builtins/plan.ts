import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import type { ToolDeps, ToolSpec } from "../contract.ts";
import { summarize } from "../render.ts";
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
 * "Approve & execute" is one action, and this is the tool it calls: given a
 * plan whose content hash still matches its plan_approval record, materialize
 * the unchecked GFM steps as shared todo items in order. Execution then
 * proceeds through the normal todo -> work -> review loop; the plan file stays
 * the drafting-time authority, the todo store the execution-time one.
 */
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
    renderCall: (input) => `execute_plan ${summarize(input.path)}`,
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
      todos.items = items;

      return {
        content: `plan approved by ${record.approvedBy}; queued ${items.length} step(s) as todos:\n${items
          .map((item) => `- ${item.content}`)
          .join("\n")}`,
      };
    },
  };
  return spec as unknown as ToolSpec;
}
