import type { CostEstimate } from "@agency/guard";

/** Solo stays solo below this many independent items. */
export const ESCALATION_MIN_TEAM_ITEMS = 3;
/** A plan longer than this opens a team even without disjoint scopes. */
export const ESCALATION_PLAN_STEP_THRESHOLD = 3;

export interface EscalationInput {
  itemCount: number;
  disjointScopes: boolean;
  planSteps: number;
  explicitRequest: boolean;
}

export interface EscalationDecision {
  openTeam: boolean;
  reason: string;
}

// Structural trigger only: cost approval still runs through
// checkCostForecast at dispatch time, never inside this decision.
export function decideEscalation(input: EscalationInput): EscalationDecision {
  if (input.explicitRequest) return { openTeam: true, reason: "explicit user request" };
  if (input.itemCount >= ESCALATION_MIN_TEAM_ITEMS && input.disjointScopes) {
    return {
      openTeam: true,
      reason: `${String(input.itemCount)} independent items with disjoint path scopes`,
    };
  }
  if (input.planSteps > ESCALATION_PLAN_STEP_THRESHOLD) {
    return {
      openTeam: true,
      reason: `plan step count ${String(input.planSteps)} over threshold ${String(ESCALATION_PLAN_STEP_THRESHOLD)}`,
    };
  }
  return {
    openTeam: false,
    reason: `stays solo: ${String(input.itemCount)} items below the team threshold`,
  };
}

// Two scopes overlap when one prefix-covers the other after
// normalization, so sibling trees count as disjoint.
export function scopesOverlap(a: string, b: string): boolean {
  const norm = (s: string): string =>
    s
      .replace(/\\/g, "/")
      .replace(/\/\*\*$/, "")
      .replace(/\/$/, "");
  const x = norm(a);
  const y = norm(b);
  if (x === y || x === "" || y === "") return true;
  return x.startsWith(`${y}/`) || y.startsWith(`${x}/`);
}

export function areScopesDisjoint(scopes: readonly (readonly string[] | undefined)[]): boolean {
  const flat = scopes.map((s) => s ?? []);
  for (let i = 0; i < flat.length; i++) {
    for (let j = i + 1; j < flat.length; j++) {
      for (const a of flat[i] ?? []) {
        for (const c of flat[j] ?? []) {
          if (scopesOverlap(a, c)) return false;
        }
      }
    }
  }
  return true;
}

export interface TeamAnnouncement {
  handles: readonly string[];
  reason: string;
  estimate: CostEstimate;
}

// One line, emitted before the first spawn, so escalation is
// visible in scrollback: who, why, and what it may cost.
export function formatTeamAnnouncement(input: TeamAnnouncement): string {
  const { handles, reason, estimate } = input;
  const range = `$${estimate.lowUsd.toFixed(2)}-${estimate.highUsd.toFixed(2)}`;
  return `team open: ${handles.join(", ")} (${String(handles.length)} agents) for ${reason} est ${range}`;
}
