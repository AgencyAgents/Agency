/**
 * Title prompt: generate a short single-line title (<=50 chars) for a
 * conversation. Temperature is the caller's responsibility and NOT pinned here
 * so the caller can adjust for creativity vs precision per use case.
 */
export function titlePrompt(): string {
  return (
    "Generate a short title for this conversation. Output a single line, no " +
    "more than 50 characters. Capture the core topic or goal. Do not include " +
    "quotes, labels, or prefixes like 'Title:'. Just the title text."
  );
}
