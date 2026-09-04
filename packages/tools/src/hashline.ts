import { createHash } from "node:crypto";

/**
 * Hashline chunk formatter + canonicalization (item 55).
 *
 * Three related pieces live here:
 *
 * 1. Canonicalization — every hash is computed over a canonical form so
 *    `\\r\\n` vs `\\n` vs lone `\\r` line endings and whitespace drift
 *    (indentation, space/tab runs) never change a line's sha256, while any
 *    real content change does.
 * 2. Hashline chunk tags — streaming reads wrap each chunk in
 *    `<hashline ...>` / `</hashline>` so a consumer can verify integrity
 *    per chunk without re-reading the file.
 * 3. Unified diffs — `unifiedDiff` emits hunks with correct `@@` counts
 *    (counts always equal the body lines they describe).
 */

/** Normalize one line for hashing: strip a stray `\\r`, trim the edges, collapse space/tab runs. */
export function canonicalizeLine(line: string): string {
  const noCr = line.endsWith("\r") ? line.slice(0, -1) : line;
  return noCr.trim().replace(/[ \t]+/g, " ");
}

/** Normalize line endings: `\\r\\n` → `\\n`, lone `\\r` → `\\n`. */
export function canonicalizeText(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

/** Split canonical text into lines (no line-ending characters retained). */
export function splitCanonicalLines(text: string): string[] {
  return canonicalizeText(text).split("\n");
}

/** sha256 (hex) of one line after canonicalization. */
export function hashCanonicalLine(line: string): string {
  return createHash("sha256").update(canonicalizeLine(line), "utf8").digest("hex");
}

/** sha256 (hex) of each canonical line of `text`. */
export function hashCanonicalLines(text: string): string[] {
  return splitCanonicalLines(text).map((line) => hashCanonicalLine(line));
}

/** sha256 (hex) of the whole canonical text (line endings normalized). */
export function hashCanonicalText(text: string): string {
  return createHash("sha256").update(canonicalizeText(text), "utf8").digest("hex");
}

// ── Hashline chunk formatter (streaming reads) ─────────────────────────────

export interface HashlineChunk {
  /** 1-based first line number of this chunk in the source file. */
  startLine: number;
  /** 1-based last line number (inclusive). */
  endLine: number;
  /** Number of lines in the chunk (`endLine - startLine + 1`). */
  lineCount: number;
  /** sha256 over the chunk's canonical lines joined with `\n`. */
  hash: string;
  /** Raw chunk text (original line endings preserved per line, joined with `\n`). */
  text: string;
}

/** Build the integrity hash for a chunk's lines (canonicalized, `\n`-joined). */
export function hashChunkLines(lines: readonly string[]): string {
  return createHash("sha256").update(lines.map(canonicalizeLine).join("\n"), "utf8").digest("hex");
}

/**
 * Format one chunk with hashline tags for streaming reads:
 *
 * ```
 * <hashline start="11" end="20" lines="10" hash="<sha256>">
 * ...chunk text (verbatim)...
 * </hashline>
 * ```
 *
 * The hash covers the canonicalized chunk lines, so a reader that
 * canonicalizes before hashing accepts `\r\n` sources transparently.
 */
export function formatHashlineChunk(startLine: number, chunkLines: readonly string[]): string {
  const text = chunkLines.join("\n");
  const endLine = startLine + chunkLines.length - 1;
  const hash = hashChunkLines(chunkLines);
  return `<hashline start="${startLine}" end="${endLine}" lines="${chunkLines.length}" hash="${hash}">\n${text}\n</hashline>`;
}

/** Split `content` into `chunkSize`-line chunks, each formatted with hashline tags. */
export function formatChunkedFile(content: string, chunkSize = 50): string {
  const safeSize = Number.isInteger(chunkSize) && chunkSize >= 1 ? chunkSize : 50;
  const lines = canonicalizeText(content).split("\n");
  // A trailing newline produces a phantom "" line — drop it so chunk ranges
  // match what a reader sees (and so empty files yield zero chunks).
  const real =
    content.endsWith("\n") && lines.length > 0 && lines[lines.length - 1] === "" ? lines.slice(0, -1) : lines;
  if (real.length === 0 || (real.length === 1 && real[0] === "" && canonicalizeText(content) === ""))
    return "";
  const chunks: string[] = [];
  for (let i = 0; i < real.length; i += safeSize) {
    const slice = real.slice(i, i + safeSize);
    chunks.push(formatHashlineChunk(i + 1, slice));
  }
  return chunks.join("\n");
}

export interface ParsedHashlineChunk extends HashlineChunk {
  /** True when `hash` matches the canonical hash of `text`'s lines. */
  valid: boolean;
}

const HASHLINE_OPEN = /^<hashline start="(\d+)" end="(\d+)" lines="(\d+)" hash="([0-9a-f]{64})">$/;

/** Parse `formatHashlineChunk`/`formatChunkedFile` output back into chunks, verifying each hash. */
export function parseHashlineChunks(formatted: string): ParsedHashlineChunk[] {
  if (formatted === "") return [];
  const lines = formatted.split("\n");
  const out: ParsedHashlineChunk[] = [];
  let i = 0;
  while (i < lines.length) {
    const open = HASHLINE_OPEN.exec(lines[i] ?? "");
    if (!open) {
      i += 1;
      continue;
    }
    const startLine = Number(open[1]);
    const endLine = Number(open[2]);
    const lineCount = Number(open[3]);
    const hash = open[4]!;
    const body: string[] = [];
    i += 1;
    while (i < lines.length && lines[i] !== "</hashline>") {
      body.push(lines[i]!);
      i += 1;
    }
    i += 1; // skip </hashline> (or run off the end)
    const text = body.join("\n");
    out.push({
      startLine,
      endLine,
      lineCount,
      hash,
      text,
      valid:
        hashChunkLines(body) === hash && body.length === lineCount && startLine + body.length - 1 === endLine,
    });
  }
  return out;
}

// ── Unified diffs with correct @@ counts ────────────────────────────────────

export interface UnifiedDiffOptions {
  /** Context lines around each change (default 3). */
  context?: number;
  /** `---`/`+++` file labels (default `a/file` / `b/file`). */
  oldPath?: string;
  newPath?: string;
}

type DiffOp = { kind: "equal" | "del" | "ins"; line: string };

/** Line-based diff via LCS (fine for edit-sized texts; deterministic). */
function diffLines(oldLines: string[], newLines: string[]): DiffOp[] {
  const n = oldLines.length;
  const m = newLines.length;
  // LCS length table
  const dp: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    const row = dp[i]!;
    const nextRow = dp[i + 1]!;
    for (let j = m - 1; j >= 0; j--) {
      row[j] = oldLines[i] === newLines[j] ? nextRow[j + 1]! + 1 : Math.max(nextRow[j]!, row[j + 1]!);
    }
  }
  const ops: DiffOp[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (oldLines[i] === newLines[j]) {
      ops.push({ kind: "equal", line: oldLines[i]! });
      i += 1;
      j += 1;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      ops.push({ kind: "del", line: oldLines[i]! });
      i += 1;
    } else {
      ops.push({ kind: "ins", line: newLines[j]! });
      j += 1;
    }
  }
  while (i < n) ops.push({ kind: "del", line: oldLines[i++]! });
  while (j < m) ops.push({ kind: "ins", line: newLines[j++]! });
  return ops;
}

function toDiffLines(text: string): string[] {
  if (text === "") return [];
  const lines = splitCanonicalLines(text);
  // `splitCanonicalLines("a\n")` → ["a", ""] — the trailing "" is the
  // terminator, not a line; drop it so counts describe real lines.
  if (text.endsWith("\n") && lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/**
 * Generate a unified diff of `oldText` → `newText` with correct `@@` counts.
 *
 * Counts are always emitted explicitly (`-a,b +c,d`, even when a count is 1)
 * and always equal the number of old-side / new-side lines in the hunk body
 * (context + deletions / context + insertions). Empty sides use the
 * `0,0` convention (`@@ -0,0 +1,N @@` for a pure addition).
 */
export function unifiedDiff(oldText: string, newText: string, options?: UnifiedDiffOptions): string {
  const context = options?.context ?? 3;
  const ctx = Number.isInteger(context) && context >= 0 ? context : 3;
  const oldLines = toDiffLines(oldText);
  const newLines = toDiffLines(newText);
  const ops = diffLines(oldLines, newLines);

  const changeIdx = ops.map((op, idx) => (op.kind === "equal" ? -1 : idx)).filter((v) => v >= 0);
  if (changeIdx.length === 0) return "";

  // Group changed ops into hunks joined by ≤ 2*ctx equal lines (index ranges).
  const ranges: Array<{ start: number; end: number }> = [];
  let hunkStart = Math.max(0, changeIdx[0]! - ctx);
  let hunkEnd = Math.min(ops.length, changeIdx[0]! + 1 + ctx);
  for (let k = 1; k < changeIdx.length; k++) {
    const prev = changeIdx[k - 1]!;
    const cur = changeIdx[k]!;
    if (cur - prev <= ctx * 2 + 1) {
      hunkEnd = Math.min(ops.length, cur + 1 + ctx);
    } else {
      ranges.push({ start: hunkStart, end: hunkEnd });
      hunkStart = Math.max(0, cur - ctx);
      hunkEnd = Math.min(ops.length, cur + 1 + ctx);
    }
  }
  ranges.push({ start: hunkStart, end: hunkEnd });

  const out: string[] = [`--- ${options?.oldPath ?? "a/file"}`, `+++ ${options?.newPath ?? "b/file"}`];
  for (const { start, end } of ranges) {
    const hunk = ops.slice(start, end);
    // Cursors: count old/new lines consumed by ops before this hunk.
    let oldStartLine = 1;
    let newStartLine = 1;
    for (let q = 0; q < start; q++) {
      const op = ops[q]!;
      if (op.kind === "equal" || op.kind === "del") oldStartLine += 1;
      if (op.kind === "equal" || op.kind === "ins") newStartLine += 1;
    }
    const oldCount = hunk.filter((o) => o.kind === "equal" || o.kind === "del").length;
    const newCount = hunk.filter((o) => o.kind === "equal" || o.kind === "ins").length;
    // Empty side starts at cursor-1 (the `0,0` convention); otherwise at cursor.
    const oldStart = oldCount === 0 ? oldStartLine - 1 : oldStartLine;
    const newStart = newCount === 0 ? newStartLine - 1 : newStartLine;
    out.push(`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`);
    for (const op of hunk) {
      out.push(`${op.kind === "equal" ? " " : op.kind === "del" ? "-" : "+"}${op.line}`);
    }
  }
  return `${out.join("\n")}\n`;
}

/** Parse one `@@ -a,b +c,d @@` header into its four counts. */
export function parseUnifiedHunkHeader(
  header: string,
): { oldStart: number; oldCount: number; newStart: number; newCount: number } | undefined {
  const m = /^@@ -(\d+),(\d+) \+(\d+),(\d+) @@/.exec(header);
  if (!m) return undefined;
  return { oldStart: Number(m[1]), oldCount: Number(m[2]), newStart: Number(m[3]), newCount: Number(m[4]) };
}
