/**
 * Tool output truncation. Oversized tool results are the single biggest
 * source of silent context-window waste, so every result flowing back into
 * the conversation goes through these caps at the `runTools` seam in
 * loop.ts. Both caps are configurable per call; the constants are the
 * session-wide defaults.
 */

/** Hard cap on a single tool result's size, in UTF-8 bytes. */
export const TRUNCATE_MAX_BYTES = 50_000;

/** Hard cap on a single tool result's line count. */
export const TRUNCATE_MAX_LINES = 2_000;

/**
 * Caps `content` at `maxLines` lines and `maxBytes` UTF-8 bytes, whichever
 * limit is hit first. A truncated result keeps its head and ends with a
 * machine-readable notice describing what was cut; content within both
 * limits is returned untouched.
 */
export function truncateOutput(
  content: string,
  maxBytes: number = TRUNCATE_MAX_BYTES,
  maxLines: number = TRUNCATE_MAX_LINES,
): { content: string; truncated: boolean } {
  const lines = content.split("\n");
  let out = content;
  let truncated = false;

  if (lines.length > maxLines) {
    const omitted = lines.length - maxLines;
    out = `${lines.slice(0, maxLines).join("\n")}\n[Output truncated at ${maxLines} lines. ${omitted} more lines omitted]`;
    truncated = true;
  }

  const bytes = Buffer.from(out, "utf8");
  if (bytes.length > maxBytes) {
    out = `${sliceAtCharBoundary(bytes, maxBytes)}\n[Output truncated at ${maxBytes} bytes]`;
    truncated = true;
  }

  return truncated ? { content: out, truncated } : { content, truncated: false };
}

/**
 * Truncates every tool result's content to the same caps. Successful results
 * carry the standard `[Output truncated at ...]` notice; error results keep
 * the identical caps but mark the cut as `[Error output truncated at ...]`
 * so a model can tell a truncated failure apart from a truncated success.
 * Results within both limits are passed through unchanged, images included.
 */
export function truncateToolResults<
  T extends { content: string; isError?: boolean; images?: Array<unknown> },
>(results: Array<T>, maxBytes: number = TRUNCATE_MAX_BYTES, maxLines: number = TRUNCATE_MAX_LINES): Array<T> {
  return results.map((result) => {
    if (result.isError) {
      const content = truncateErrorOutput(result.content, maxBytes, maxLines);
      return content === result.content ? result : { ...result, content };
    }
    const { content, truncated } = truncateOutput(result.content, maxBytes, maxLines);
    return truncated ? { ...result, content } : result;
  });
}

/** Error-flavored truncation: same caps, different notices. */
function truncateErrorOutput(content: string, maxBytes: number, maxLines: number): string {
  const lines = content.split("\n");
  let out = content;

  if (lines.length > maxLines) {
    const omitted = lines.length - maxLines;
    out = `${lines.slice(0, maxLines).join("\n")}\n[Error output truncated at ${maxLines} lines. ${omitted} more lines omitted]`;
  }

  const bytes = Buffer.from(out, "utf8");
  if (bytes.length > maxBytes) {
    out = `${sliceAtCharBoundary(bytes, maxBytes)}\n[Error output truncated at ${maxBytes} bytes]`;
  }

  return out;
}

/**
 * Cuts a UTF-8 buffer to at most `maxBytes` bytes without splitting a
 * character: any continuation bytes (10xxxxxx) at the cut point are walked
 * back to the start of the containing character.
 */
function sliceAtCharBoundary(buf: Buffer, maxBytes: number): string {
  let end = Math.min(maxBytes, buf.length);
  while (end > 0) {
    const byte = buf.at(end);
    if (byte === undefined || (byte & 0xc0) !== 0x80) break;
    end -= 1;
  }
  return buf.subarray(0, end).toString("utf8");
}
