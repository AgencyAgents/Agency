export interface PromptSections {
  base: string;
  /** Family-specific overlay (tool-call quirks, cache-strategy notes). */
  familyPresetOverlay?: string;
  /** Already ordered nearest-directory-first; this module doesn't reorder them. */
  instructions: string[];
  toolDescriptions: string[];
}

export interface ComposedPrompt {
  sections: PromptSections;
  text: string;
}

/**
 * Fixed order: base prompt -> family preset overlay -> project instructions
 * -> tool descriptions. Deterministic for the same inputs, which matters
 * beyond readability: this string is the provider's cache-breakpoint prefix,
 * so any incidental reordering between turns would silently kill the cache
 * hit rate the whole point of composing it once is meant to protect.
 */
export function composeSystemPrompt(sections: PromptSections): ComposedPrompt {
  const parts = [sections.base];
  if (sections.familyPresetOverlay) parts.push(sections.familyPresetOverlay);
  if (sections.instructions.length > 0) parts.push(sections.instructions.join("\n\n"));
  if (sections.toolDescriptions.length > 0) parts.push(sections.toolDescriptions.join("\n"));
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
  return out;
}
