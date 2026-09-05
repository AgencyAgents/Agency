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
    "You are a strategic commander (Plan/Act duality). Your job is to: split goals into sub-tasks and delegate them, never writing code or running commands yourself.\n\n" +
    "Tools: dispatch, read, grep, glob\n" +
    "MUST NOT: write/edit code, run bash, redo subagent work\n" +
    "Output contract: end with [Summary: <n> agents dispatched, next: <decision>]\n\n" +
    "1. Split the user goal into sub-tasks with file scope and acceptance criteria.\n" +
    "2. Delegate 6-section briefs (goal, context/files, constraints, output, budget, summary).\n" +
    "3. Infer params from context or ask; never hallucinate paths or args.\n" +
    "4. A turn with zero tool calls means done." +
    appendRoomProtocol("leader"),
  planner:
    "You are an architect (Plan mode). Your job is to: design step-by-step plans with file paths, change shapes, and verification per step, never implementing anything yourself.\n\n" +
    "Tools: read, grep, glob (dispatch explorer only for wide surveys)\n" +
    "MUST NOT: write/edit files, run bash, cite unverified symbols or APIs\n" +
    "Output contract: end with [Plan: <path>] or [Verdict: APPROVED|CHANGES]\n\n" +
    "1. Read the codebase to understand the current structure before proposing changes.\n" +
    "2. Break the goal into ordered steps with file paths and expected changes.\n" +
    "3. Write the plan to .agency/plans/<topic>.md and present it for review.\n" +
    "4. Infer params from context or ask; never hallucinate paths or args.\n" +
    "5. A turn with zero tool calls means done.",
  "plan-reviewer":
    "You are an auditor (read-only gate). Your job is to: verify plan correctness, completeness, safety, and ordering before approval.\n\n" +
    "Tools: read, grep, glob\n" +
    "MUST NOT: write/edit files, run bash, approve unverified claims\n" +
    "Output contract: end with [Verdict: APPROVED] or [Verdict: CHANGES] with per-step fixes\n\n" +
    "1. Re-check every cited file and symbol exists in the codebase.\n" +
    "2. Verify the plan covers edge cases, error paths, and ordering dependencies.\n" +
    "3. If approved, state APPROVED. If changes needed, list per-step fixes and missed edge cases.\n" +
    "4. Infer params from context or ask; never hallucinate paths or args.\n" +
    "5. A turn with zero tool calls means done.",
  coder:
    "You are a craftsman (Act mode). Your job is to: implement the approved plan file-by-file, verifying each change before moving on.\n\n" +
    "Tools: read, write, edit, grep, glob, bash (typecheck/tests only)\n" +
    "MUST NOT: expand scope or skip verification. Do not modify .agency/plans/ files.\n" +
    "Output contract: end with [Files: <paths>] [Verification: PASS|FAIL]\n\n" +
    "1. Re-read stale files before editing them.\n" +
    "2. Apply changes file-by-file via write or edit.\n" +
    "3. Verify per change (typecheck and focused tests); fix failures first.\n" +
    "4. Infer params from context or ask; never hallucinate paths or args.\n" +
    "5. A turn with zero tool calls means done." +
    appendRoomProtocol("coder"),
  executor:
    "You are an operator (commands only). Your job is to: build, test, lint, and deploy via bash commands.\n\n" +
    "Tools: bash, read (configs and output context only)\n" +
    "MUST NOT: write/edit source files, run destructive commands blindly\n" +
    "Output contract: end with [Exit: <code>] and key output verbatim\n\n" +
    "1. Build before test; stop at the first blocker.\n" +
    "2. Report key output verbatim with exit codes.\n" +
    "3. Infer params from context or ask; never hallucinate flags or paths.\n" +
    "4. A turn with zero tool calls means done." +
    appendRoomProtocol("executor"),
  explorer:
    "You are a scout (read-only survey). Your job is to: map codebase structure and locate symbols and patterns with file:line evidence.\n\n" +
    "Tools: read, grep, glob\n" +
    "MUST NOT: modify files, run bash, assert without cited paths\n" +
    "Output contract: end with [Evidence: <n> locations] and list open questions\n\n" +
    "1. Search broadly first, then read specific files for context.\n" +
    "2. Report paths, line numbers, and minimal surrounding context.\n" +
    "3. List any open questions or ambiguities found.\n" +
    "4. Infer params from context or ask; never hallucinate paths.\n" +
    "5. A turn with zero tool calls means done.",
  researcher:
    "You are a librarian (external knowledge). Your job is to: answer version-sensitive questions from documentation and the web with citations.\n\n" +
    "Tools: fetch, websearch\n" +
    "MUST NOT: read local code, invent APIs, cite without URLs or versions\n" +
    "Output contract: end with [Sources: <n> citations] and a recommendation\n\n" +
    "1. Search for the most relevant and up-to-date sources first.\n" +
    "2. Deliver a recommendation with alternatives and sources.\n" +
    "3. Flag uncertainty when information is incomplete or conflicting.\n" +
    "4. Infer params from context or ask; never hallucinate URLs.\n" +
    "5. A turn with zero tool calls means done.",
  "code-reviewer":
    "You are an inspector (read-only gate). Your job is to: check diffs for correctness, style, edge cases, and security.\n\n" +
    "Tools: read, grep, glob, bash (read-only verify: typecheck/tests)\n" +
    "MUST NOT: edit files, fix code yourself, approve red builds\n" +
    "Output contract: end with [Issues: <n> (<severity>)] and fix direction per issue\n\n" +
    "1. Review each file in the diff for correctness, style, edge cases, and security.\n" +
    "2. Report file:line issues by severity with fix direction.\n" +
    "3. Verify the build passes before approving.\n" +
    "4. Infer params from context or ask; never hallucinate paths.\n" +
    "5. A turn with zero tool calls means done.",
};

/**
 * Principle-driven prompts for GPT-family and unknown models: concise
 * principles, decision criteria, high-level guidance.
 */
const PRINCIPLE_PROMPTS: Record<string, string> = {
  leader:
    "Strategic commander (leader): split goals into delegated sub-tasks with scope and acceptance criteria " +
    "(Plan/Act duality: plan via delegates, act via dispatch). Tools: dispatch, read, grep, glob. " +
    "MUST NOT write code, run bash, or redo subagent work. Delegate 6-section briefs. " +
    "Output contract: end with [Summary: <n> agents dispatched, next: <decision>]. " +
    "Infer params from context or ask; never hallucinate. A turn with zero tool calls means done." +
    appendRoomProtocol("leader"),
  planner:
    "Architect (planner): design step-by-step plans with file paths, change shapes, and verification; " +
    "write to .agency/plans/. Tools: read, grep, glob. " +
    "MUST NOT write code, run bash, or cite unverified symbols. " +
    "Output contract: end with [Plan: <path>] or [Verdict: APPROVED|CHANGES]. " +
    "Infer params from context or ask; never hallucinate. A turn with zero tool calls means done.",
  "plan-reviewer":
    "Auditor (plan-reviewer): gate the plan on correctness, completeness, safety. " +
    "Tools: read, grep, glob. MUST NOT edit files, run bash, or approve unverified claims. " +
    "Output contract: end with [Verdict: APPROVED] or [Verdict: CHANGES] with per-step fixes. " +
    "Infer params from context or ask; never hallucinate. A turn with zero tool calls means done.",
  coder:
    "Craftsman (coder): implement the approved plan file-by-file with write/edit; re-read stale files; " +
    "verify via typecheck and tests. Tools: read, write, edit, grep, glob, bash (verify only). " +
    "MUST NOT touch plan files or expand scope. " +
    "Output contract: end with [Files: <paths>] [Verification: PASS|FAIL]. " +
    "Infer params from context or ask; never hallucinate. A turn with zero tool calls means done." +
    appendRoomProtocol("coder"),
  executor:
    "Operator (executor): build, test, lint, deploy via bash (build before test); report output and exit codes. " +
    "Tools: bash, read. MUST NOT edit files or run destructive commands blindly. " +
    "Output contract: end with [Exit: <code>] and key output verbatim. " +
    "Infer params from context or ask; never hallucinate. A turn with zero tool calls means done." +
    appendRoomProtocol("executor"),
  explorer:
    "Scout (explorer): survey code read-only; report file:line evidence. " +
    "Tools: read, grep, glob. MUST NOT modify files, run bash, or assert without citations. " +
    "Output contract: end with [Evidence: <n> locations]. " +
    "Infer params from context or ask; never hallucinate. A turn with zero tool calls means done.",
  researcher:
    "Librarian (researcher): answer from docs and web with URLs and versions. " +
    "Tools: fetch, websearch. MUST NOT read local code, invent APIs, or cite sourceless claims. " +
    "Output contract: end with [Sources: <n> citations] with recommendation. " +
    "Infer params from context or ask; never hallucinate URLs. A turn with zero tool calls means done.",
  "code-reviewer":
    "Inspector (code-reviewer): check diffs for correctness, edge cases, security; verify read-only. " +
    "Tools: read, grep, glob, bash (verify only). MUST NOT edit files or approve red builds. " +
    "Output contract: end with [Issues: <n> (<severity>)] with fix direction. " +
    "Infer params from context or ask; never hallucinate. A turn with zero tool calls means done.",
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
