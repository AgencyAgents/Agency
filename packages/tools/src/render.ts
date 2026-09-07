const MAX_SUMMARY_CHARS = 120;

export function firstLine(text: string): string {
  const newline = text.indexOf("\n");
  return (newline === -1 ? text : text.slice(0, newline)).trim();
}

export function lineCount(text: string): number {
  if (text.length === 0) return 0;
  let count = 1;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) count++;
  }
  return count;
}

/**
 * Collapses tool output into the one bounded line a transcript frame renders:
 * first line, " (+N lines)" when more follow, ellipsized at `max` chars.
 */
export function summarize(text: string, max = MAX_SUMMARY_CHARS): string {
  const line = firstLine(text);
  const body = line.length > max ? `${line.slice(0, max)}…` : line;
  const extraLines = lineCount(text) - 1;
  return extraLines > 0 ? `${body} (+${extraLines} lines)` : body;
}

/** First line only, ellipsized at `max` chars (no line-count suffix). */
export function clip(text: string, max = MAX_SUMMARY_CHARS): string {
  const line = firstLine(text);
  return line.length > max ? `${line.slice(0, max)}…` : line;
}

/** Tool input fields are model-produced JSON: never trust their runtime type. */
export function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export function itemCount(value: unknown): number {
  return Array.isArray(value) ? value.length : 0;
}
