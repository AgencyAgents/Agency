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

// biome-ignore lint/suspicious/noControlCharactersInRegex: escape sequences of a terminal
const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g;

/** A line that says one test passed: cargo, pytest -v, go test -v, jest, vitest, mocha and bun. */
const PASSING =
  /^test \S.* \.\.\. ok$|\sPASSED(\s+\[\s*\d+%\])?$|^\s*(=== (RUN|PAUSE|CONT)|--- PASS:)\s|^\s*[✓✔√]\s|^PASS\s+\S|^\(pass\)\s/;

/**
 * Shell output as the model needs it, with nothing it could read taken away: no colour codes, a line that a progress
 * bar redrew with `\r` as its last text, a run of the same line as one line and its count, and a run of passing tests
 * as their count. The failures and the summary of a test run stay.
 */
export function compactOutput(text: string): string {
  const raw = text
    .replace(ANSI, "")
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => {
      const parts = line.split("\r").filter((part) => part !== "");
      return parts[parts.length - 1] ?? "";
    });
  const lines: string[] = [];
  for (let i = 0; i < raw.length; ) {
    let j = i;
    while (j < raw.length && PASSING.test(raw[j] as string)) j += 1;
    if (j === i) {
      lines.push(raw[i] as string);
      i += 1;
      continue;
    }
    if (j - i > 2) lines.push(`[${j - i} lines of passing tests or checks]`);
    else lines.push(...raw.slice(i, j));
    i = j;
  }
  const out: string[] = [];
  for (let i = 0; i < lines.length; ) {
    let j = i + 1;
    while (j < lines.length && lines[j] === lines[i]) j += 1;
    out.push(lines[i] as string);
    if (j - i > 2 && lines[i] !== "") out.push(`[the line above ${j - i - 1} more times]`);
    else for (let k = i + 1; k < j; k++) out.push(lines[k] as string);
    i = j;
  }
  return out.join("\n");
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
 * Truncation with disk spill: content within `maxBytes` passes through untouched. A longer one keeps its start
 * and its end, and the full text goes to a temp file whose path is appended, so the model can read the rest.
 */
export function truncateWithSpill(
  content: string,
  maxBytes: number,
  notices: { truncated: (path: string) => string; truncatedNoSpill: string },
): string {
  const bytes = Buffer.from(content, "utf8");
  if (bytes.length <= maxBytes) return content;
  // The end stays too: the error of a build or a test run is there.
  const half = Math.floor(maxBytes / 2);
  const head = sliceAtCharBoundary(bytes, half);
  let start = bytes.length - half;
  while (start < bytes.length && ((bytes.at(start) ?? 0) & 0xc0) === 0x80) start += 1;
  const tail = bytes.subarray(start).toString("utf8");
  const omitted = bytes.length - Buffer.byteLength(head) - (bytes.length - start);
  const spillPath = spillToTempFile(content);
  const notice = spillPath ? notices.truncated(spillPath) : notices.truncatedNoSpill;
  return `${head}\n[... ${omitted} bytes omitted ...]\n${tail}\n${notice}`;
}
