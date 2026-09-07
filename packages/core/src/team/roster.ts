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

// Sync credential pass: config apiKey or AGENCY_<PROVIDER>_API_KEY in
// env. Keychain needs async access, so this is the first-run gate only.
export function providersWithCredentials(opts: {
  configProviders?: Record<string, { apiKey?: string; env?: string[] }>;
  env?: NodeJS.ProcessEnv;
}): string[] {
  const env = opts.env ?? process.env;
  const names = new Set<string>();
  for (const [name, pc] of Object.entries(opts.configProviders ?? {})) {
    if (typeof pc?.apiKey === "string" && pc.apiKey.length > 0) names.add(name);
    for (const varName of pc?.env ?? []) {
      if ((env[varName] ?? "").length > 0) names.add(name);
    }
  }
  for (const key of Object.keys(env)) {
    const m = /^AGENCY_(.+)_(API_KEY)$/.exec(key);
    if (m?.[1] && (env[key] ?? "").length > 0) names.add(m[1].toLowerCase());
  }
  return [...names].sort();
}

export interface RosterAgentRef {
  provider?: string;
  model?: string;
}

// Remaps roles whose provider has no credentials to the first
// available one, recording every remap so the report can cite it.
export function resolveRosterProviders<T extends RosterAgentRef>(
  agents: Record<string, T>,
  available: readonly string[],
): { agents: Record<string, T>; remapped: string[] } {
  const first = available[0];
  if (first === undefined) return { agents: { ...agents }, remapped: [] };
  const out: Record<string, T> = {};
  const remapped: string[] = [];
  for (const [handle, agent] of Object.entries(agents)) {
    if (agent.provider !== undefined && available.includes(agent.provider)) {
      out[handle] = agent;
      continue;
    }
    out[handle] = { ...agent, provider: first };
    remapped.push(handle);
  }
  return { agents: out, remapped };
}
