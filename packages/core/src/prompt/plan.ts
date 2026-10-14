import { type ComposedPrompt, type SystemReminder, withSystemReminders } from "./compose.ts";

export const PLAN_WORKFLOW_PHASES = ["explore", "design", "write", "present", "approve"] as const;
export type PlanWorkflowPhase = (typeof PLAN_WORKFLOW_PHASES)[number];

const PLAN_PHASE_TEXT: Record<PlanWorkflowPhase, string> = {
  explore: "Phase 1/5 explore: read the codebase (read/grep/glob) before proposing anything.",
  design: "Phase 2/5 design: break the goal into ordered steps with file paths and expected changes.",
  write:
    "Phase 3/5 write: save the plan as markdown to .opencode/plans/<epoch>-<slug>.md; edit only plan files.",
  present: "Phase 4/5 present: call plan_exit to ask the Yes/No approval question, then end your turn.",
  approve: "Phase 5/5 approve: on Yes the plan is approved for execution; on No revise and ask again.",
};

export function planWorkflowReminder(phase: PlanWorkflowPhase): SystemReminder {
  return { kind: "plan_mode", text: PLAN_PHASE_TEXT[phase] };
}

export function allPlanWorkflowReminders(): SystemReminder[] {
  return PLAN_WORKFLOW_PHASES.map(planWorkflowReminder);
}

export function isPlanWorkflowPhase(value: string): value is PlanWorkflowPhase {
  return (PLAN_WORKFLOW_PHASES as readonly string[]).includes(value);
}

/** Act requires a valid approval: present plan content matches approved hash. */
export function isActTransitionAllowed(approval: { hash: string } | undefined, currentHash: string): boolean {
  return approval !== undefined && approval.hash === currentHash;
}

export const SessionReminders = {
  apply(composed: ComposedPrompt, reminders: readonly SystemReminder[]): ComposedPrompt {
    return withSystemReminders(composed, reminders);
  },

  planWorkflow(phase: PlanWorkflowPhase): SystemReminder {
    return planWorkflowReminder(phase);
  },

  allPlanPhases(): SystemReminder[] {
    return allPlanWorkflowReminders();
  },
};
