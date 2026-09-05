import { relative, resolve } from "node:path";
import type { TrustStore } from "./trust.ts";

/**
 * One permission verdict. The `allow | ask | deny` triad is opencode's model:
 * `allow` runs without asking, `ask` routes through the approval callback
 * (once / always / reject), `deny` refuses — and, at the tool-list level, a
 * bare `deny` means the tool is never even offered to the model.
 */
export type Decision = "allow" | "ask" | "deny";

/** How risky a tool is by nature; drives default decisions and the trust gate. */
export type RiskTier = "safe" | "moderate" | "dangerous";

export interface PolicyRequest {
  tool: string;
  /** Requested path (workspace-relative for rules built from permissions config). */
  path?: string;
  /** Raw command string as the model wrote it. */
  command?: string;
  /** Arity-normalized command (see `normalizeCommand`); rules match either form. */
  normalizedCommand?: string;
}

export interface PolicyRule {
  /** Tool name, or "*" to match any. */
  tool: string;
  /** Glob-ish match against the request's path, when present. */
  pathGlob?: string;
  /** Regex source matched against the request's command (and its normalized form). */
  commandPattern?: string;
  decision: Decision;
}

/** A single tool's permission entry: a bare decision or a pattern map. */
export type ToolPermissionValue = Decision | Record<string, Decision>;

/** Everything one tool-call needs for a permission verdict. */
export interface ToolCallPolicyRequest {
  tool: string;
  riskTier?: RiskTier;
  /** Raw path argument as the model wrote it (relative or absolute). */
  path?: string;
  /** Raw command argument (bash). */
  command?: string;
}

/**
 * The seam the agent loop consults before running a tool. Implemented by
 * `PermissionsGate`; the loop accepts any structural implementation so tests
 * can substitute fakes.
 */
export interface ToolPolicy {
  check(
    request: ToolCallPolicyRequest,
    ask: ((request: ApprovalRequestLike) => Promise<"once" | "always" | "reject">) | undefined,
  ): Promise<"allow" | "deny">;
}

/** Structural stand-in for the approval callback type (avoids an import cycle). */
export interface ApprovalRequestLike {
  tool: string;
  title: string;
  command?: string;
  path?: string;
  metadata?: Record<string, unknown>;
}

/** Tools whose pattern maps match path arguments (workspace-relative). */
const PATH_PATTERN_TOOLS = new Set(["write", "edit", "read", "execute_plan"]);
/** Tools whose pattern maps match command strings. */
const COMMAND_PATTERN_TOOLS = new Set(["bash"]);

/**
 * First-party orchestration tools. They spawn bounded subagent turns (budgets,
 * depth bounds, and per-agent gates are the controls), so the gate allows them
 * by default in workspaces where mutating tools may run. Explicit config
 * entries still win (including `deny`), per-agent maps still filter unlisted
 * tools, and the trust gate in `check` still denies them in untrusted
 * workspaces — this allow is unreachable there.
 */
const ORCHESTRATION_TOOLS: ReadonlySet<string> = new Set(["dispatch", "task"]);

export function isPathPatternTool(tool: string): boolean {
  return PATH_PATTERN_TOOLS.has(tool);
}

export function isCommandPatternTool(tool: string): boolean {
  return COMMAND_PATTERN_TOOLS.has(tool);
}

/**
 * opencode's arity table: how many words of a command to keep when normalizing
 * (`git` → 2, so `git checkout main` normalizes to `git checkout`). This lets
 * exact patterns like `git checkout` match regardless of branch names, and is
 * deliberately textual — no tree-sitter, no shell parser. Regex against a raw
 * string is trivially bypassed by `eval`, `$(...)`, `;`; a full parser is
 * overkill. This is the right amount of machinery.
 */
export const COMMAND_ARITY: Readonly<Record<string, number>> = {
  git: 2,
  gh: 2,
  npm: 2,
  npx: 2,
  pnpm: 2,
  yarn: 2,
  bun: 2,
  bunx: 2,
  deno: 2,
  cargo: 2,
  go: 2,
  rustup: 2,
  pip: 2,
  pip3: 2,
  uv: 2,
  uvx: 2,
  docker: 2,
  kubectl: 2,
  helm: 2,
  terraform: 2,
  biome: 2,
  rm: 2,
  mv: 2,
  cp: 2,
  ln: 2,
  mkdir: 2,
  chmod: 2,
  chown: 2,
  rg: 2,
  grep: 2,
  find: 2,
  sed: 2,
  curl: 2,
  wget: 2,
  ssh: 2,
  scp: 2,
  rsync: 2,
  tar: 2,
  apt: 2,
  brew: 2,
};

/**
 * Keeps at most `arity` whitespace-separated words of `command` (the command
 * word itself counts: `git` → 2 keeps `git checkout` from `git checkout main`).
 * Commands whose first word isn't in the table are returned trimmed as-is.
 */
export function normalizeCommand(
  command: string,
  arity: Readonly<Record<string, number>> = COMMAND_ARITY,
): string {
  const words = command
    .trim()
    .split(/\s+/)
    .filter((w) => w.length > 0);
  const first = words[0];
  if (words.length === 0 || first === undefined) return "";
  const keep = arity[first];
  if (keep === undefined) return words.join(" ");
  return words.slice(0, keep).join(" ");
}

/**
 * Compiles a glob into an anchored regex source. Path mode treats `*` as
 * within-segment (a slash-crossing wildcard is the double-star form), a
 * trailing double-star covers the directory itself and everything under it,
 * and a leading double-star-slash matches any depth. Command mode treats `*`
 * as crossing anything so `git *` matches whole command strings.
 */
export function globToRegExpSource(glob: string, mode: "path" | "command"): string {
  // The permission-map convention: a lone `*` means "everything" for any
  // subject kind (e.g. `{"write": {"*": "deny", ".agency/plans/**": "allow"}}`).
  if (glob === "*") return "^.*$";
  const source = glob.replace(/\\/g, "/");
  let re = "";
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    if (ch === undefined) break;
    if (ch === "*") {
      if (source[i + 1] === "*") {
        if (source[i + 2] === "/") {
          re += "(?:.*/)?";
          i += 3;
          continue;
        }
        if (re.endsWith("/")) {
          // A trailing `/**` covers the directory itself and everything under it.
          re = `${re.slice(0, -1)}(?:/.*)?`;
        } else {
          re += ".*";
        }
        i += 2;
        continue;
      }
      re += mode === "path" ? "[^/]*" : ".*";
      i += 1;
      continue;
    }
    if (ch === "?") {
      re += mode === "path" ? "[^/]" : ".";
      i += 1;
      continue;
    }
    re += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    i += 1;
  }
  return `^${re}$`;
}

const globCache = new Map<string, RegExp>();

function globRegExp(glob: string, mode: "path" | "command"): RegExp {
  const key = `${mode}\u0000${glob}`;
  let compiled = globCache.get(key);
  if (!compiled) {
    compiled = new RegExp(globToRegExpSource(glob, mode));
    globCache.set(key, compiled);
  }
  return compiled;
}

function globMatches(glob: string, value: string, mode: "path" | "command"): boolean {
  if (mode === "path" && process.platform === "win32") {
    // Windows paths are case-insensitive; a case mismatch must not defeat a rule.
    return globRegExp(glob.toLowerCase(), mode).test(value.toLowerCase());
  }
  return globRegExp(glob, mode).test(value);
}

function ruleMatches(rule: PolicyRule, request: PolicyRequest): boolean {
  if (rule.tool !== "*" && rule.tool !== request.tool) return false;
  if (rule.pathGlob && (!request.path || !globMatches(rule.pathGlob, request.path, "path"))) {
    return false;
  }
  if (rule.commandPattern) {
    const pattern = new RegExp(rule.commandPattern);
    const rawMatch = request.command !== undefined && pattern.test(request.command);
    const normalizedMatch =
      request.normalizedCommand !== undefined && pattern.test(request.normalizedCommand);
    if (!rawMatch && !normalizedMatch) return false;
  }
  return true;
}

/**
 * Converts a permissions-config entry set into precedence-ordered rules for the
 * `PolicyEngine`. Pattern maps are emitted in REVERSED entry and pattern order
 * so the engine's first-match-wins walk implements the config model's
 * last-match-wins semantics, with an `ask` catch-all per mapped tool so an
 * unmatched command/path fails safe instead of falling through to the engine
 * default. Bare decisions become single tool-level rules.
 *
 * Path patterns are matched against workspace-relative paths; command patterns
 * match both the raw and arity-normalized command.
 */
export function rulesFromPermissions(permissions: Record<string, ToolPermissionValue>): PolicyRule[] {
  const rules: PolicyRule[] = [];
  for (const [tool, value] of Object.entries(permissions).reverse()) {
    if (typeof value === "string") {
      rules.push({ tool, decision: value });
      continue;
    }
    const entries = Object.entries(value).reverse();
    for (const [pattern, decision] of entries) {
      if (isCommandPatternTool(tool)) {
        rules.push({ tool, commandPattern: globToRegExpSource(pattern, "command"), decision });
      } else if (isPathPatternTool(tool)) {
        rules.push({ tool, pathGlob: pattern, decision });
      } else if (pattern === "*") {
        rules.push({ tool, decision });
      }
      // Non-wildcard patterns on a tool with neither command nor path subjects
      // can never match meaningfully; skip them rather than silently matching.
    }
    // Nothing matched in the map: fail safe with an ask rather than the
    // engine-level default, so a partially-specified map never silently allows.
    rules.push({ tool, decision: "ask" });
  }
  return rules;
}

/**
 * First-match-wins over a precedence-ordered rule list (most specific /
 * highest-priority source first, the way callers assemble that order from layered
 * config the same way P0's config loader does). Falls back to `defaultDecision`
 * when nothing matches, so an unconfigured tool doesn't silently run.
 *
 * The permissions-config path (`rulesFromPermissions` + `PermissionsGate`)
 * layers opencode's last-match-wins maps on top of the same engine by reversing
 * rule order — one evaluator, both semantics.
 */
export class PolicyEngine {
  constructor(
    private readonly rules: readonly PolicyRule[],
    private readonly defaultDecision: Decision = "ask",
  ) {}

  evaluate(request: PolicyRequest): Decision {
    // Commands are matched against both the raw and the arity-normalized
    // form; normalize on the caller's behalf when only the raw form arrived.
    const subject =
      request.command !== undefined && request.normalizedCommand === undefined
        ? { ...request, normalizedCommand: normalizeCommand(request.command) }
        : request;
    for (const rule of this.rules) {
      if (ruleMatches(rule, subject)) return rule.decision;
    }
    return this.defaultDecision;
  }
}

/** Workspace-relative, forward-slash form of `candidate` (absolute or relative). */
export function relativeWorkspacePath(root: string, candidate: string): string {
  const rel = relative(resolve(root), resolve(root, candidate)).replace(/\\/g, "/");
  return rel === "" ? "." : rel;
}

/**
 * The production permission gate: evaluates the `permissions` config through the
 * `PolicyEngine`, filters the tool list (two-level policy: a tool absent from a
 * per-agent map, or mapped to a bare `deny`, is not offered to the model at
 * all), gates on workspace trust for tools above the `safe` risk tier, and
 * resolves `ask` decisions through the approval callback. With no callback
 * available an `ask` fails closed (deny) — a headless run must never silently
 * approve itself.
 */
export class PermissionsGate implements ToolPolicy {
  private readonly engine: PolicyEngine;
  private readonly permissions: Record<string, ToolPermissionValue>;

  constructor(
    private readonly options: {
      permissions?: Record<string, ToolPermissionValue>;
      workspaceRoot: string;
      /** Per-agent policy mode: tools absent from the map are filtered entirely. */
      absentToolsDenied?: boolean;
      /** Trust gate: tools above `safe` refuse to run in an untrusted workspace. */
      trust?: { store: TrustStore; root: string; required: boolean };
    },
  ) {
    this.permissions = options.permissions ?? {};
    this.engine = new PolicyEngine(rulesFromPermissions(this.permissions), "ask");
  }

  /**
   * Two-level policy: should the tool be in the list offered to the model.
   * A bare `deny` never is; with `absentToolsDenied` (per-agent policies) an
   * unlisted tool isn't either; otherwise unlisted tools follow their risk
   * tier (`safe` offered, everything else offered but asking per call).
   */
  toolOffered(tool: string, riskTier?: RiskTier): boolean {
    const entry = this.permissions[tool];
    if (entry === "deny") return false;
    if (entry === undefined) {
      if (this.options.absentToolsDenied) return false;
      return this.defaultFor(riskTier) !== "deny";
    }
    return true;
  }

  /** The verdict without consulting approvals (the engine + defaults only). */
  decisionFor(request: ToolCallPolicyRequest): Decision {
    const entry = this.permissions[request.tool];
    if (entry === undefined) {
      if (this.options.absentToolsDenied) return "deny";
      if (ORCHESTRATION_TOOLS.has(request.tool) && this.workspaceAllowsOrchestration()) return "allow";
      const decision = this.defaultFor(request.riskTier);
      if (decision === "allow" && this.isEnvRead(request)) return "deny";
      return decision;
    }
    if (typeof entry === "string") {
      if (entry === "allow" && this.isEnvRead(request)) return "deny";
      return entry;
    }

    const subject: PolicyRequest = { tool: request.tool };
    if (request.command !== undefined && isCommandPatternTool(request.tool)) {
      subject.command = request.command;
      subject.normalizedCommand = normalizeCommand(request.command);
    }
    if (request.path !== undefined && isPathPatternTool(request.tool)) {
      subject.path = relativeWorkspacePath(this.options.workspaceRoot, request.path);
    }
    const decision = this.engine.evaluate(subject);
    if (decision === "allow" && this.isEnvRead(request)) return "deny";
    return decision;
  }

  /**
   * The `external_directory` permission governs access outside the workspace
   * root. Accepts a bare decision or a directory-glob map (matched against the
   * resolved absolute path, forward-slash form); defaults to `deny`, which is
   * the sandbox's historical behavior.
   */
  externalDirectoryDecision(absolutePath: string): Decision {
    const entry = (this.permissions as { external_directory?: ToolPermissionValue }).external_directory;
    if (entry === undefined) return "deny";
    if (typeof entry === "string") return entry;
    const normalized = absolutePath.replace(/\\/g, "/");
    let matched: Decision | undefined;
    for (const [glob, decision] of Object.entries(entry)) {
      if (globMatches(glob, normalized, "path")) matched = decision; // last match wins
    }
    return matched ?? "ask";
  }

  async check(
    request: ToolCallPolicyRequest,
    ask: ((request: ApprovalRequestLike) => Promise<"once" | "always" | "reject">) | undefined,
  ): Promise<"allow" | "deny"> {
    // Trust gate: mutating or executing tools require a trusted workspace.
    // Read-only (`safe`) tools still work — refusing trust leaves a usable,
    // read-only session instead of a dead one. Only an explicit "safe" tier
    // passes: a missing or unrecognized tier is untrusted input (a dynamically
    // loaded plugin tool is the obvious source — `riskTier` is an
    // interface-only guarantee, never runtime-validated), so it defaults to
    // unsafe and is denied here.
    const trust = this.options.trust;
    if (trust?.required && (request.riskTier ?? "dangerous") !== "safe") {
      if (!trust.store.isTrusted(trust.root)) return "deny";
    }

    const decision = this.decisionFor(request);
    if (decision === "allow") return "allow";
    if (decision === "deny") return "deny";
    if (!ask) return "deny"; // no approval surface: fail closed

    const response = await ask({
      tool: request.tool,
      title: request.command ?? request.path ?? request.tool,
      command: request.command,
      path: request.path,
      metadata: { riskTier: request.riskTier },
    });
    return response === "reject" ? "deny" : "allow";
  }

  /**
   * Returns true when the request is a path-scoped read of a `.env` file that
   * has no explicit allow in the permissions config. This implements the
   * auto-deny policy: `.env` files are never readable by default, even when
   * the tool's riskTier is `safe` and no explicit permission is configured.
   */
  private isEnvRead(request: ToolCallPolicyRequest): boolean {
    if (!request.path) return false;
    if (!isPathPatternTool(request.tool)) return false;
    const relPath = relativeWorkspacePath(this.options.workspaceRoot, request.path);
    if (!globMatches("**/.env/**", relPath, "path") && !globMatches("**/.env*", relPath, "path")) {
      return false;
    }
    // If there's an explicit allow for this path, respect it.
    return !this.hasExplicitAllow(request.tool, relPath);
  }

  private hasExplicitAllow(tool: string, relPath: string): boolean {
    const entry = this.permissions[tool];
    if (entry === undefined) return false;
    if (typeof entry === "string") return entry === "allow";
    for (const [pattern, decision] of Object.entries(entry)) {
      if (decision === "allow" && globMatches(pattern, relPath, "path")) return true;
    }
    return false;
  }

  /**
   * Verdict for a tool with no configured permission: `safe` tools run,
   * everything else asks. A missing tier is untrusted input, so it fails safe
   * to `ask` rather than silently allowing.
   */
  private defaultFor(riskTier?: RiskTier): Decision {
    return riskTier === "safe" ? "allow" : "ask";
  }

  /**
   * True when the workspace may run mutating tools: trust gating is off, or
   * the trust store marks this root trusted. Absent trust options fail closed.
   * Mirrors the trust gate in `check`, so this allow never widens it.
   */
  private workspaceAllowsOrchestration(): boolean {
    const trust = this.options.trust;
    if (!trust) return false;
    if (!trust.required) return true;
    try {
      return trust.store.isTrusted(trust.root);
    } catch {
      return false;
    }
  }
}
