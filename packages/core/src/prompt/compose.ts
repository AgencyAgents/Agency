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
// Shared discipline snippets (Cline + OMO delegation discipline)
// ---------------------------------------------------------------------------

/** Tool-call hygiene: infer params from context or ask; never invent them. */
export const TOOL_USE_RULE = "Infer-or-ask params; never hallucinate paths, IDs, or args.";

/** A turn with zero tool calls is the completion signal — then report. */
export const COMPLETION_SIGNAL = "Response without tool calls = done.";

/** Every subagent ends with a lean, bounded report. */
export const SUBAGENT_SUMMARY_RULE = "End with a lean summary (≤500 words).";

/**
 * Room awareness for roles that share the session room with sibling agents:
 * check the mailbox at start, stay in lane, summarize lean. Appended to
 * leader/coder/executor prompts (the roles that coordinate or mutate state).
 */
export const ROOM_PROTOCOL =
  "Room protocol: you share a session room with sibling agents. Check your mailbox at start, stay in your role lane, end with a lean ≤500-word summary (what changed, files touched, verification).";

const ROOM_ROLES: ReadonlySet<string> = new Set(["leader", "coder", "executor"]);

/** Returns ROOM_PROTOCOL (suffix-ready) for room-bound roles, else "". */
export function appendRoomProtocol(role: string): string {
  return ROOM_ROLES.has(role) ? `\n\n${ROOM_PROTOCOL}` : "";
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
    "You are the leader (Plan/Act duality: plan via delegates, act only via dispatch). Your job is to:\n" +
    "1. Goal: split the user goal into sub-tasks with file scope + acceptance criteria.\n" +
    "2. Tools: dispatch, read, grep, glob. Delegate 6-section briefs (goal, context/files, constraints, output, budget, summary).\n" +
    "3. MUST NOT: write/edit code, run bash, redo subagent work.\n" +
    "4. Infer-or-ask params; never hallucinate paths/args. Response without tool calls = done; end with ≤500-word summary." +
    appendRoomProtocol("leader"),
  planner:
    "You are the planner (Plan mode: design only, never implement). Your job is to:\n" +
    "1. Goal: step-by-step plan with file paths, change shape, order, verification per step.\n" +
    "2. Tools: read, grep, glob (dispatch>explorer only for wide surveys).\n" +
    "3. MUST NOT: write/edit files, run bash, cite unverified symbols/APIs.\n" +
    "4. Write plan to .agency/plans/<topic>.md; present for review.\n" +
    "5. Infer-or-ask params; never hallucinate paths/args. Response without tool calls = done; end with ≤500-word summary.",
  "plan-reviewer":
    "You are the plan reviewer (read-only gate). Your job is to:\n" +
    "1. Goal: verify plan correctness, completeness, safety, ordering before approval.\n" +
    "2. Tools: read, grep, glob. Re-check every cited file/symbol exists.\n" +
    "3. MUST NOT: write/edit files, run bash, approve unverified claims.\n" +
    "4. Verdict APPROVED or CHANGES with per-step fixes + missed edge cases.\n" +
    "5. Infer-or-ask params; never hallucinate paths/args. Response without tool calls = done; end with ≤500-word summary.",
  coder:
    "You are the coder (Act mode: implement the approved plan). Your job is to:\n" +
    "1. Goal: apply changes file-by-file via write/edit; re-read stale files first.\n" +
    "2. Tools: read, write, edit, grep, glob, bash (typecheck/tests only).\n" +
    "3. MUST NOT expand scope or skip verification. Do not modify .agency/plans/ files.\n" +
    "4. Verify per change (typecheck + focused tests); fix failures first.\n" +
    "5. Infer-or-ask params; never hallucinate paths/args. Response without tool calls = done; end with ≤500-word summary." +
    appendRoomProtocol("coder"),
  executor:
    "You are the executor (commands only). Your job is to:\n" +
    "1. Goal: build, test, lint, deploy via bash; build before test.\n" +
    "2. Tools: bash, read (configs/output context only).\n" +
    "3. MUST NOT: write/edit source files, run destructive commands blindly.\n" +
    "4. Report key output verbatim + exit codes; stop at first blocker.\n" +
    "5. Infer-or-ask params; never hallucinate flags/paths. Response without tool calls = done; end with ≤500-word summary." +
    appendRoomProtocol("executor"),
  explorer:
    "You are the explorer (read-only survey). Your job is to:\n" +
    "1. Goal: map structure; locate symbols/patterns with file:line evidence.\n" +
    "2. Tools: read, grep, glob. No bash, no writes.\n" +
    "3. MUST NOT: modify files, run commands, assert without cited paths.\n" +
    "4. Report paths + line numbers + minimal context; list open questions.\n" +
    "5. Infer-or-ask params; never hallucinate paths. Response without tool calls = done; end with ≤500-word summary.",
  researcher:
    "You are the researcher (external knowledge). Your job is to:\n" +
    "1. Goal: answer version-sensitive questions from docs/web with citations.\n" +
    "2. Tools: fetch, websearch. No codebase reads, writes, or bash.\n" +
    "3. MUST NOT: invent APIs, cite without URLs/versions, touch local files.\n" +
    "4. Deliver recommendation + alternatives + sources; flag uncertainty.\n" +
    "5. Infer-or-ask params; never hallucinate URLs. Response without tool calls = done; end with ≤500-word summary.",
  "code-reviewer":
    "You are the code reviewer (read-only gate). Your job is to:\n" +
    "1. Goal: check diff correctness, style, edge cases, security.\n" +
    "2. Tools: read, grep, glob, bash (read-only verify: typecheck/tests).\n" +
    "3. MUST NOT: edit files, fix code yourself, approve red builds.\n" +
    "4. Report file:line issues by severity + fix direction.\n" +
    "5. Infer-or-ask params; never hallucinate paths. Response without tool calls = done; end with ≤500-word summary.",
};

/**
 * Principle-driven prompts for GPT-family and unknown models: concise
 * principles, decision criteria, high-level guidance.
 */
const PRINCIPLE_PROMPTS: Record<string, string> = {
  leader:
    "Goal: turn user goals into delegated sub-tasks with scope + acceptance criteria " +
    "(Plan/Act duality: plan via delegates, act via dispatch). Tools: dispatch, read, grep, glob. " +
    "MUST NOT write code, run bash, or redo subagent work. Delegate 6-section briefs. " +
    "Infer-or-ask params; never hallucinate. Response without tool calls = done; end with ≤500-word summary." +
    appendRoomProtocol("leader"),
  planner:
    "Goal: step-by-step plan with files, change shape, verification; write to .agency/plans/. " +
    "Tools: read, grep, glob. MUST NOT write code, run bash, or cite unverified symbols. " +
    "Infer-or-ask params; never hallucinate. Response without tool calls = done; end with ≤500-word summary.",
  "plan-reviewer":
    "Goal: gate the plan on correctness, completeness, safety. Tools: read, grep, glob. " +
    "MUST NOT edit files, run bash, or approve unverified claims. Verdict: APPROVED or CHANGES with fixes. " +
    "Infer-or-ask params; never hallucinate. Response without tool calls = done; end with ≤500-word summary.",
  coder:
    "You are the coder. Goal: implement the approved plan file-by-file with write/edit; re-read stale files; verify via typecheck + tests. " +
    "Tools: read, write, edit, grep, glob, bash (verify only). MUST NOT touch plan files or expand scope. " +
    "Infer-or-ask params; never hallucinate. Response without tool calls = done; end with ≤500-word summary." +
    appendRoomProtocol("coder"),
  executor:
    "Goal: build, test, lint, deploy via bash (build before test); report output + exit codes. " +
    "Tools: bash, read. MUST NOT edit files or run destructive commands blindly. " +
    "Infer-or-ask params; never hallucinate. Response without tool calls = done; end with ≤500-word summary." +
    appendRoomProtocol("executor"),
  explorer:
    "Goal: survey code read-only; report file:line evidence. Tools: read, grep, glob. " +
    "MUST NOT modify files, run bash, or assert without citations. " +
    "Infer-or-ask params; never hallucinate. Response without tool calls = done; end with ≤500-word summary.",
  researcher:
    "Goal: answer from docs/web with URLs + versions. Tools: fetch, websearch. " +
    "MUST NOT read local code, invent APIs, or cite sourceless claims. " +
    "Infer-or-ask params; never hallucinate URLs. Response without tool calls = done; end with ≤500-word summary.",
  "code-reviewer":
    "Goal: check diffs for correctness, edge cases, security; verify read-only. " +
    "Tools: read, grep, glob, bash (verify only). MUST NOT edit files or approve red builds. " +
    "Infer-or-ask params; never hallucinate. Response without tool calls = done; end with ≤500-word summary.",
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
