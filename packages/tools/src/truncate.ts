import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Cuts a UTF-8 buffer to at most `maxBytes` bytes without splitting a
 * character: any continuation bytes (10xxxxxx) at the cut point are walked
 * back to the start of the containing character. Mirrors
 * `sliceAtCharBoundary` in core/src/truncate.ts — kept local rather than
 * imported because @agency/tools does not depend on @agency/core.
 */
export function sliceAtCharBoundary(buf: Buffer, maxBytes: number): string {
  let end = Math.min(maxBytes, buf.length);
  while (end > 0) {
    const byte = buf.at(end);
    if (byte === undefined || (byte & 0xc0) !== 0x80) break;
    end -= 1;
  }
  return buf.subarray(0, end).toString("utf8");
}

/**
 * Spills oversized tool output to a temp file so nothing is silently dropped:
 * the caller returns a truncated head plus the spill path, and the full text
 * stays readable on disk. Returns undefined when the write fails — callers
 * fall back to a plain truncation notice.
 */
export function spillToTempFile(content: string, prefix = "agency-tool-output"): string | undefined {
  const path = join(tmpdir(), `${prefix}-${Date.now()}-${randomUUID().slice(0, 8)}.txt`);
  try {
    writeFileSync(path, content, "utf8");
    return path;
  } catch {
    return undefined;
  }
}

/**
 * Head-keeping truncation with disk spill: content within `maxBytes` passes
 * through untouched; overflow is cut at a character boundary and the FULL
 * text is written to a temp file whose path is appended, so the model can
 * re-read what was dropped.
 */
export function truncateWithSpill(
  content: string,
  maxBytes: number,
  notices: { truncated: (path: string) => string; truncatedNoSpill: string },
): string {
  const bytes = Buffer.from(content, "utf8");
  if (bytes.length <= maxBytes) return content;
  const head = sliceAtCharBoundary(bytes, maxBytes);
  const spillPath = spillToTempFile(content);
  return `${head}\n${spillPath ? notices.truncated(spillPath) : notices.truncatedNoSpill}`;
}
