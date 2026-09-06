import type { ComposedPrompt } from "./compose.ts";

/**
 * Current prompt version. Bump this when any prompt shape or content changes
 * in a way that downstream consumers (tracing, caching, observability) should
 * observe. Follows semver: MAJOR breaking, MINOR additive, PATCH fixes.
 */
export const PROMPT_VERSION = "1.0.0";

/**
 * Appends a `<prompt-version>` tag to the composed text so every provider
 * interaction carries the prompt contract version. The tag sits after the
 * context block (the most dynamic section), keeping the stable cache prefix
 * intact.
 */
export function withPromptVersion(composed: ComposedPrompt): ComposedPrompt {
  const tag = `<prompt-version>${PROMPT_VERSION}</prompt-version>`;
  return {
    ...composed,
    segments: [...composed.segments, { stability: "dynamic", text: tag }],
    text: `${composed.text}\n\n${tag}`,
  };
}
