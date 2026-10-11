// Reviewer-first default composition: one writer plus read-only
// reviewers, capped at the researched 3 to 5 agents per team.
export const TEAM_ROSTER_MIN = 3;
export const TEAM_ROSTER_MAX = 5;

export interface TeamComposition {
  writer: string;
  reviewers: string[];
  total: number;
}

export function defaultTeamComposition(opts: {
  writers: readonly string[];
  reviewers: readonly string[];
  max?: number;
}): TeamComposition {
  const max = opts.max ?? TEAM_ROSTER_MAX;
  const writer = opts.writers[0] ?? opts.reviewers[0] ?? "coder";
  const reviewers = opts.reviewers.filter((r) => r !== writer).slice(0, Math.max(0, max - 1));
  return { writer, reviewers, total: 1 + reviewers.length };
}

/** Genuinely multi-provider spread: writers on strong models,
// reviewers and scouts on cheaper families by default. */
export const ROLE_PROVIDERS: Record<string, { provider: string; model: string }> = {
  leader: { provider: "anthropic", model: "claude-sonnet-5" },
  planner: { provider: "openai", model: "gpt-5.2" },
  "plan-reviewer": { provider: "google", model: "gemini-3-pro" },
  coder: { provider: "anthropic", model: "claude-sonnet-5" },
  executor: { provider: "openai", model: "gpt-5.2" },
  explorer: { provider: "google", model: "gemini-3-pro" },
  researcher: { provider: "openai", model: "gpt-5.2" },
  "code-reviewer": { provider: "google", model: "gemini-3-pro" },
};
