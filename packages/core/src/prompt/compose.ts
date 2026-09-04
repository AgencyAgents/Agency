export interface PromptSections {
  base: string;
  /** Family-specific overlay (tool-call quirks, cache-strategy notes). */
  familyPresetOverlay?: string;
  /** Already ordered nearest-directory-first; this module doesn't reorder them. */
  instructions: string[];
  toolDescriptions: string[];
  /**
   * Pre-rendered environment block (OS, cwd, date, git state — see
   * `buildEnvironmentBlock`). Joined LAST on purpose: it's the most dynamic
   * section (the date alone changes every minute), so keeping it after the
   * stable sections preserves the longest possible cache prefix.
   */
  context?: string;
}

export interface ComposedPrompt {
  sections: PromptSections;
  text: string;
  /** Set by `withSystemReminders`; absent when no reminders applied this turn. */
  reminders?: SystemReminder[];
}

// ---------------------------------------------------------------------------
// Family-specific role prompts
// ---------------------------------------------------------------------------

/**
 * Mechanics-driven prompts for Claude-family models: explicit checklists,
 * numbered steps, concrete procedures. Selected when the resolved model's
 * `family` is `"anthropic"`.
 */
const MECHANICS_PROMPTS: Record<string, string> = {
  leader:
    "You are the leader. Your job is to:\n" +
    "1. Understand the high-level goal from the user.\n" +
    "2. Break it into clear sub-tasks and assign them to the right agents.\n" +
    "3. Review results from each agent and decide next steps.\n" +
    "4. Report progress back to the user concisely.\n" +
    "Use the dispatch tool to delegate work. Do not perform every task yourself.",
  planner:
    "You are the planner. Your job is to:\n" +
    "1. Read the goal and the existing codebase structure.\n" +
    "2. Design a step-by-step plan with file paths and expected changes.\n" +
    "3. Write the plan to .agency/plans/ as a markdown file.\n" +
    "4. Present the plan for review before any code is written.\n" +
    "Do not write code. Do not run commands. Focus on the plan only.",
  "plan-reviewer":
    "You are the plan reviewer. Your job is to:\n" +
    "1. Read the plan from .agency/plans/.\n" +
    "2. Check each step for correctness, completeness, and safety.\n" +
    "3. Identify missing edge cases or risky changes.\n" +
    "4. Approve the plan or send it back with specific revision requests.\n" +
    "Do not write code. Do not modify files. Review only.",
  coder:
    "You are the coder. Your job is to:\n" +
    "1. Read the approved plan and the relevant source files.\n" +
    "2. Implement each change one file at a time using write/edit.\n" +
    "3. Run typecheck and tests after each logical change.\n" +
    "4. Fix any failures before moving to the next step.\n" +
    "Do not modify .agency/plans/ files. Stick to the approved plan.",
  executor:
    "You are the executor. Your job is to:\n" +
    "1. Run bash commands to build, test, lint, and deploy.\n" +
    "2. Report command output verbatim when relevant.\n" +
    "3. Chain commands logically: fix build errors before running tests.\n" +
    "4. Do not edit source files. Execute only.",
  explorer:
    "You are the explorer. Your job is to:\n" +
    "1. Read source files to understand the codebase structure.\n" +
    "2. Search for symbols, patterns, and definitions using grep/glob.\n" +
    "3. Report findings clearly: file paths, line numbers, relevant context.\n" +
    "4. Do not modify files. Do not run bash. Explore and report only.",
  researcher:
    "You are the researcher. Your job is to:\n" +
    "1. Fetch documentation and web resources using fetch/websearch.\n" +
    "2. Look up API references, best practices, and library docs.\n" +
    "3. Summarize findings with citations where possible.\n" +
    "4. Do not read the codebase directly. Do not modify files.",
  "code-reviewer":
    "You are the code reviewer. Your job is to:\n" +
    "1. Read the changed files and the diff.\n" +
    "2. Check for correctness, style, edge cases, and security issues.\n" +
    "3. Run read-only bash commands to verify the build or tests pass.\n" +
    "4. Report issues with specific file paths and line numbers.\n" +
    "Do not edit files. Review only.",
};

/**
 * Principle-driven prompts for GPT-family and unknown models: concise
 * principles, decision criteria, high-level guidance.
 */
const PRINCIPLE_PROMPTS: Record<string, string> = {
  leader:
    "You are the leader. Understand the goal, delegate sub-tasks via dispatch, " +
    "review results, and report progress. Focus on orchestration, not execution.",
  planner:
    "You are the planner. Read the goal and codebase, design a step-by-step plan, " +
    "write it to .agency/plans/, and present it for review. Do not write code or run commands.",
  "plan-reviewer":
    "You are the plan reviewer. Read the plan, evaluate correctness and safety, " +
    "identify gaps, and approve or request revisions. Do not write code or modify files.",
  coder:
    "You are the coder. Read the approved plan, implement changes with write/edit, " +
    "run typecheck and tests, and fix failures. Avoid modifying .agency/plans/.",
  executor:
    "You are the executor. Run bash commands to build, test, lint, and deploy. " +
    "Report output. Do not edit source files.",
  explorer:
    "You are the explorer. Read files and search the codebase with grep/glob. " +
    "Report findings with file paths and context. Do not modify files or run bash.",
  researcher:
    "You are the researcher. Fetch documentation and web resources. " +
    "Summarize findings with citations. Do not read the codebase directly.",
  "code-reviewer":
    "You are the code reviewer. Read diffs, check correctness and security, " +
    "run read-only verification commands, and report issues. Do not edit files.",
};

/**
 * Maps model family to its prompt variant. Claude-family gets mechanics-driven
 * prompts (explicit checklists/procedures); everything else gets principle-driven
 * prompts (concise principles/decision criteria).
 */
const FAMILY_PROMPTS: Record<string, Record<string, string> | undefined> = {
  anthropic: MECHANICS_PROMPTS,
  deepseek: PRINCIPLE_PROMPTS,
  glm: PRINCIPLE_PROMPTS,
  google: PRINCIPLE_PROMPTS,
  openai: PRINCIPLE_PROMPTS,
};

/**
 * Returns the role-specific prompt section for a given model family. Unknown
 * families fall back to principle-driven (PRINCIPLE_PROMPTS).
 */
export function resolveFamilyPrompt(family: string, role: string): string {
  const prompts = FAMILY_PROMPTS[family] ?? PRINCIPLE_PROMPTS;
  return prompts[role] ?? PRINCIPLE_PROMPTS[role] ?? `You are a ${role}.`;
}

// ---------------------------------------------------------------------------
// Prompt composition
// ---------------------------------------------------------------------------

/**
 * Fixed order: stable prefix (ident+role+instructions) then dynamic sections
 * (context). Deterministic for the same inputs, which matters beyond
 * readability: this string is the provider's cache-breakpoint prefix, so any
 * incidental reordering between turns would silently kill the cache hit rate
 * the whole point of composing it once is meant to protect.
 *
 * Stable prefix — identity (base) + role (familyPresetOverlay) + instructions:
 *   These sections are deterministic for the same model/workspace/role and
 *   form the longest possible provider prompt-cache prefix. They are built
 *   first so the beginning of the prompt string is byte-identical across
 *   turns where only the dynamic tail changes.
 *
 * Dynamic sections — context (environment block with date) + reminders:
 *   Appended last so the stable prefix survives across turns for cache hits.
 *   Reminders are appended by `withSystemReminders` after composition, so
 *   turns with no active reminders keep the exact same prompt string.
 */
export function composeSystemPrompt(sections: PromptSections): ComposedPrompt {
  // Stable prefix: identity + role + instructions + tool descriptions
  const stable: string[] = [sections.base];
  if (sections.familyPresetOverlay) stable.push(sections.familyPresetOverlay);
  if (sections.instructions.length > 0) stable.push(sections.instructions.join("\n\n"));
  if (sections.toolDescriptions.length > 0) stable.push(sections.toolDescriptions.join("\n"));

  // Dynamic sections: context (environment block with date) appended last
  const dynamic: string[] = [];
  if (sections.context) dynamic.push(sections.context);

  const text = [...stable, ...dynamic].join("\n\n");
  return { sections, text };
}

/** `/prompt`: the resolved sections for inspection, not just the flattened string. */
export function describePrompt(composed: ComposedPrompt): Array<{ label: string; content: string }> {
  const out: Array<{ label: string; content: string }> = [{ label: "base", content: composed.sections.base }];
  if (composed.sections.familyPresetOverlay) {
    out.push({ label: "family preset", content: composed.sections.familyPresetOverlay });
  }
  composed.sections.instructions.forEach((text, i) => {
    out.push({ label: `instructions[${i}]`, content: text });
  });
  composed.sections.toolDescriptions.forEach((text, i) => {
    out.push({ label: `tool[${i}]`, content: text });
  });
  if (composed.sections.context) out.push({ label: "context", content: composed.sections.context });
  if (composed.reminders && composed.reminders.length > 0) {
    out.push({ label: "reminders", content: formatSystemReminders(composed.reminders) });
  }
  return out;
}

/**
 * One dynamic, per-turn notice. Reminders exist so state that only applies to
 * some turns (plan mode, a file that changed under us, an MCP server that
 * died) reaches the model on exactly those turns instead of being padded into
 * every system prompt as static text.
 */
export type SystemReminderKind = "plan_mode" | "file_changed" | "mcp_server_down" | (string & {});

export interface SystemReminder {
  kind: SystemReminderKind;
  text: string;
}

export const SYSTEM_REMINDER_OPEN = "<system-reminder>";
export const SYSTEM_REMINDER_CLOSE = "</system-reminder>";

/** Renders the active reminders as one tagged block; empty list renders "" so
 *  turns without reminders keep the exact same system prompt as before. */
export function formatSystemReminders(reminders: readonly SystemReminder[]): string {
  if (reminders.length === 0) return "";
  const lines = reminders.map((r) => `- [${r.kind}] ${r.text}`);
  return [SYSTEM_REMINDER_OPEN, ...lines, SYSTEM_REMINDER_CLOSE].join("\n");
}

/** Appends the reminder block for THIS turn. Returns `composed` unchanged when
 *  the list is empty — the no-padding guarantee: only turns with active
 *  reminders pay for them (in bytes and in cache prefix). */
export function withSystemReminders(
  composed: ComposedPrompt,
  reminders: readonly SystemReminder[],
): ComposedPrompt {
  const block = formatSystemReminders(reminders);
  if (block === "") return composed;
  return {
    sections: composed.sections,
    reminders: [...reminders],
    text: `${composed.text}\n\n${block}`,
  };
}

/** Plan/read-only mode is active this turn: the model must not attempt writes. */
export function readOnlyReminder(): SystemReminder {
  return {
    kind: "plan_mode",
    text: "Read-only (plan) mode is active: do not modify files or run state-changing commands. Present a plan for approval instead.",
  };
}

/** A file the conversation previously read has changed on disk since. */
export function fileChangedReminder(path: string): SystemReminder {
  return {
    kind: "file_changed",
    text: `The file ${path} changed on disk since you last read it. Re-read it before editing — do not trust stale line numbers or content.`,
  };
}

/** An MCP server stopped responding (at startup or mid-session); its tools are gone. */
export function mcpServerDownReminder(name: string, reason?: string): SystemReminder {
  return {
    kind: "mcp_server_down",
    text: `MCP server "${name}" is unavailable${reason ? `: ${reason}` : ""}. Its tools cannot be called in this state.`,
  };
}
