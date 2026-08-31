export type Decision = "allow" | "ask" | "deny";

export interface PolicyRequest {
  tool: string;
  path?: string;
  command?: string;
}

export interface PolicyRule {
  /** Tool name, or "*" to match any. */
  tool: string;
  /** Glob-ish prefix match against the request's path, when present. */
  pathGlob?: string;
  /** Substring/regex-lite match against the request's command, when present. */
  commandPattern?: string;
  decision: Decision;
}

function globMatches(glob: string, value: string): boolean {
  if (glob === "*") return true;
  if (glob.endsWith("/**")) return value.startsWith(glob.slice(0, -3));
  if (glob.endsWith("*")) return value.startsWith(glob.slice(0, -1));
  return value === glob;
}

function ruleMatches(rule: PolicyRule, request: PolicyRequest): boolean {
  if (rule.tool !== "*" && rule.tool !== request.tool) return false;
  if (rule.pathGlob && (!request.path || !globMatches(rule.pathGlob, request.path))) return false;
  if (rule.commandPattern && (!request.command || !new RegExp(rule.commandPattern).test(request.command))) {
    return false;
  }
  return true;
}

/**
 * First-match-wins over a precedence-ordered rule list (most specific /
 * highest-priority source first — callers assemble that order from layered
 * config the same way P0's config loader does). Falls back to `defaultDecision`
 * when nothing matches, so an unconfigured tool doesn't silently run.
 */
export class PolicyEngine {
  constructor(
    private readonly rules: readonly PolicyRule[],
    private readonly defaultDecision: Decision = "ask",
  ) {}

  evaluate(request: PolicyRequest): Decision {
    for (const rule of this.rules) {
      if (ruleMatches(rule, request)) return rule.decision;
    }
    return this.defaultDecision;
  }
}
