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

/**
 * Fixed order: base prompt -> family preset overlay -> project instructions
 * -> tool descriptions -> environment context. Deterministic for the same
 * inputs, which matters beyond readability: this string is the provider's
 * cache-breakpoint prefix, so any incidental reordering between turns would
 * silently kill the cache hit rate the whole point of composing it once is
 * meant to protect.
 */
export function composeSystemPrompt(sections: PromptSections): ComposedPrompt {
  const parts = [sections.base];
  if (sections.familyPresetOverlay) parts.push(sections.familyPresetOverlay);
  if (sections.instructions.length > 0) parts.push(sections.instructions.join("\n\n"));
  if (sections.toolDescriptions.length > 0) parts.push(sections.toolDescriptions.join("\n"));
  if (sections.context) parts.push(sections.context);
  return { sections, text: parts.join("\n\n") };
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
