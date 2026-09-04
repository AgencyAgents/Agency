import { createHash } from "node:crypto";
import { t } from "@agency/i18n";
import { AgencyError, ErrorCode } from "@agency/schema";
import { canonicalizeLine, canonicalizeText } from "./hashline.ts";

export interface EditRequest {
  oldText: string;
  newText: string;
  /** Explicit opt-in to replace every occurrence (renames), instead of the
   *  default single-occurrence requirement. */
  replaceAll?: boolean;
}

/** One search/replace unit of a multi-hunk edit. */
export interface EditHunk {
  oldText: string;
  newText: string;
  replaceAll?: boolean;
}

/** One language-server diagnostic, narrowed to what edit verification reports. */
export interface EditDiagnostic {
  /** LSP severity: 1=Error 2=Warning 3=Information 4=Hint. */
  severity: number;
  message: string;
  /** 0-based line. */
  line: number;
  /** 0-based character. */
  character: number;
}

/**
 * The LSP seam (P7): a sync read of the diagnostics a language server has
 * already pushed for `path`. Push-based publishDiagnostics means the cached
 * read IS the query; an empty result (no server, no diagnostics) never blocks
 * or fails an edit.
 */
export type DiagnosticsProvider = (path: string) => readonly EditDiagnostic[];

export interface EditVerificationResult {
  content: string;
  /** Error-severity diagnostics the language server reports for the file. */
  warnings: string[];
}

export function errorDiagnostics(diagnostics: readonly EditDiagnostic[]): string[] {
  return diagnostics
    .filter((d) => d.severity === 1)
    .map((d) => `${d.line + 1}:${d.character + 1} ${d.message}`);
}

/**
 * applyEdit plus the LSP verification hook: diagnostics are read before the
 * edit is applied and error-severity ones ride along as warnings. The edit
 * itself is never blocked by them (or by a missing server); surfacing them is
 * the model's cue to re-check its work.
 */
export function applyEditVerified(
  content: string,
  request: EditRequest,
  options?: { path?: string; diagnostics?: DiagnosticsProvider },
): EditVerificationResult {
  const updated = applyEdit(content, request);
  const diagnostics = options?.path && options.diagnostics ? options.diagnostics(options.path) : [];
  return { content: updated, warnings: errorDiagnostics(diagnostics) };
}

/**
 * Multi-hunk form of applyEditVerified: applies every hunk against the
 * working copy, then reads diagnostics once. Exact-duplicate hunks (same
 * oldText, newText, and replaceAll) are deduplicated first so a repeated
 * hunk applies once instead of double-applying or tripping ambiguity.
 * Remaining hunks are ordered bottom-to-top (by their position in the
 * original content) so that earlier-line edits are not shifted by
 * later-line insertions. Overlapping hunks are deduplicated: when two
 * hunks match overlapping ranges, only the first (bottom-most) is
 * applied. All-or-nothing falls out of applyEdit's throw-on-reject — a
 * rejected hunk discards the working copy and the caller never writes a
 * partially-edited file.
 */
export function applyEditsVerified(
  content: string,
  hunks: readonly EditHunk[],
  options?: { path?: string; diagnostics?: DiagnosticsProvider },
): EditVerificationResult {
  // Comment-slop autocorrect (item 54): normalize every hunk before any
  // positioning/dedupe so spans are computed on the clean anchors.
  const corrected = hunks.map((h) => autocorrectHunk(h).hunk);
  // Exact-duplicate dedupe (item 56): identical hunks (same oldText,
  // newText, replaceAll) collapse to one, preserving first-seen order.
  // Range-overlap dedupe below would also drop them, but making it
  // explicit keeps duplicates safe if overlap ever hardens to a reject.
  const seen = new Set<string>();
  const unique = corrected.filter((h) => {
    const key = JSON.stringify([h.oldText, h.newText, h.replaceAll ?? false]);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  // Find each hunk's position in the original content using all match strategies
  const positioned: { hunk: EditHunk; start: number; end: number }[] = [];

  for (const hunk of unique) {
    const pos = findHunkSpan(content, hunk);
    if (pos === undefined) {
      // Let applyEdit produce the canonical error for this hunk
      let current = content;
      for (const h of unique) current = applyEdit(current, h);
      const diags = options?.path && options.diagnostics ? options.diagnostics(options.path) : [];
      return { content: current, warnings: errorDiagnostics(diags) };
    }
    positioned.push({ hunk, start: pos.start, end: pos.end });
  }

  // Sort bottom-to-top by start position (descending); when tied, the
  // longer span (larger end) is bottom-most and wins on overlap.
  positioned.sort((a, b) => b.start - a.start || b.end - a.end);

  // Dedupe overlapping hunks: skip hunks whose range overlaps any accepted one
  const deduped: typeof positioned = [];
  for (const p of positioned) {
    const overlaps = deduped.some((d) => p.start < d.end && p.end > d.start);
    if (!overlaps) deduped.push(p);
  }

  // Apply in bottom-to-top order
  let current = content;
  for (const { hunk } of deduped) current = applyEdit(current, hunk);

  const diagnostics = options?.path && options.diagnostics ? options.diagnostics(options.path) : [];
  return { content: current, warnings: errorDiagnostics(diagnostics) };
}

function countOccurrences(content: string, needle: string): number {
  if (needle.length === 0) return 0;
  let count = 0;
  let index = content.indexOf(needle);
  while (index !== -1) {
    count += 1;
    index = content.indexOf(needle, index + needle.length);
  }
  return count;
}

function preview(text: string): string {
  return text.length > 200 ? `${text.slice(0, 200)}…` : text;
}

function editError(message: string, context: Record<string, unknown>): AgencyError {
  return new AgencyError(ErrorCode.TOOL_ERROR, message, { source: "edit", context });
}

// ── Hashline content-hash validation ──────────────────────────────────────
// Each line of oldText is hashed (sha256) after canonicalization (see
// hashline.ts): line endings normalized, edges trimmed, internal
// space/tab runs collapsed. Tolerant of indentation drift and
// whitespace-run differences while still rejecting content changes.

function normalizedLineHash(line: string): string {
  return createHash("sha256").update(canonicalizeLine(line), "utf8").digest("hex");
}

/** Compute sha256 hashes for every line in `text` (after normalization). */
function lineHashes(text: string): string[] {
  return canonicalizeText(text).split("\n").map(normalizedLineHash);
}

/**
 * Find all regions in `content` where consecutive lines have sha256 hashes
 * matching those of `oldText` (after normalization). Returns the byte spans
 * of every match, or an empty array when nothing matches.
 *
 * This is a fuzzy-anchor strategy: it matches when exact text differs due to
 * whitespace but the line-by-line content (modulo whitespace) is identical.
 */
function findAllHashAnchors(content: string, oldText: string): SpanMatch[] {
  // Split into lines, tracking each line's byte start and end positions
  // (end = position after line content, before any \n or \r\n separator)
  // so spans are correct regardless of line-ending style.
  const contentLines: string[] = [];
  const lineStarts: number[] = [0];
  const lineEnds: number[] = [];
  const re = /\r\n|\r|\n/;
  let lastIndex = 0;
  for (const match of content.matchAll(new RegExp(re.source, "g"))) {
    contentLines.push(content.slice(lastIndex, match.index));
    lineEnds.push(match.index);
    lastIndex = match.index + match[0].length;
    lineStarts.push(lastIndex);
  }
  contentLines.push(content.slice(lastIndex));
  lineEnds.push(content.length);

  const oldHashes = lineHashes(oldText);

  if (oldHashes.length === 0 || contentLines.length < oldHashes.length) return [];

  const spans: SpanMatch[] = [];
  for (let i = 0; i <= contentLines.length - oldHashes.length; i++) {
    let match = true;
    for (let j = 0; j < oldHashes.length; j++) {
      if (normalizedLineHash(contentLines[i + j]!) !== oldHashes[j]!) {
        match = false;
        break;
      }
    }
    if (match) {
      spans.push({ start: lineStarts[i]!, end: lineEnds[i + oldHashes.length - 1]! });
    }
  }
  return spans;
}

function findHashAnchor(content: string, oldText: string): SpanMatch | undefined {
  const spans = findAllHashAnchors(content, oldText);
  return spans.length > 0 ? spans[0] : undefined;
}

/**
 * Find the byte span of `hunk.oldText` in `content` using all available
 * match strategies (exact → hashline → whitespace-tolerant regex). Returns
 * undefined when no strategy finds a unique match.
 */
function findHunkSpan(content: string, hunk: EditHunk): SpanMatch | undefined {
  // Exact match
  const exact = content.indexOf(hunk.oldText);
  if (exact !== -1) return { start: exact, end: exact + hunk.oldText.length };

  // Hashline match
  const hashSpan = findHashAnchor(content, hunk.oldText);
  if (hashSpan !== undefined) return hashSpan;

  // Whitespace-tolerant regex match (only when unique)
  const pattern = whitespaceTolerantRegExp(hunk.oldText);
  if (pattern) {
    const spans = matchAllSpans(content, pattern);
    if (spans.length === 1) return spans[0]!;
  }

  return undefined;
}

/**
 * Comment-slop scanner + autocorrect (item 54). Model-generated hunks often
 * carry trailing junk lines — continuation tokens (`...`, `// ...`),
 * markdown fences, or merge/diff markers — and flat (zero-indent) `newText`
 * for line-paired replacements. Both shapes reject at patch time, so hunks
 * are normalized here before any matching runs. Autocorrect never invents
 * new rejections: it bails out unchanged when stripping would empty a side.
 */
export function isSlopLine(line: string): boolean {
  const trimmed = line.trim();
  if (trimmed.length === 0) return false;
  if (/^```/.test(trimmed)) return true;
  if (/^(<{7}|>{7}|\|{7}|={7})/.test(trimmed)) return true;
  if (/^(@@\s|diff --git\s|index\s[\da-f]+\.\.[\da-f]+|\+\+\+\s|---\s)/.test(trimmed)) return true;
  if (/^(\.\.\.|…|⋯)+$/.test(trimmed)) return true;
  const prefixes = ["//", "#", "--", "/*", "*", "<!--", ";;", "%"];
  const prefix = prefixes.find((p) => trimmed.startsWith(p));
  if (prefix !== undefined) {
    let body = trimmed.slice(prefix.length);
    if (prefix === "/*") body = body.replace(/\*\/\s*$/, "");
    if (prefix === "<!--") body = body.replace(/-->\s*$/, "");
    body = body.trim();
    if (/^(\.\.\.|…|⋯)+$/.test(body)) return true;
    if (
      body.length > 0 &&
      body.length <= 80 &&
      /(rest|remain|unchang|same|snip|truncat|continu|etc\.?|omit|elid|more\s+(code|below)|follow)/i.test(
        body,
      )
    ) {
      return true;
    }
    return false;
  }
  if (
    /(\.\.\.|…|⋯)/.test(trimmed) &&
    trimmed.length <= 80 &&
    /(rest|remain|unchang|same|snip|truncat|continu|more|below|above)/i.test(trimmed)
  ) {
    return true;
  }
  return false;
}

/** Strip trailing slop lines from `text`, keeping at least one content line. */
export function stripTrailingSlop(text: string): { text: string; stripped: string[] } {
  const hadTrailingNl = text.endsWith("\n");
  const lines = text.split("\n");
  let end = hadTrailingNl ? lines.length - 1 : lines.length;
  const stripped: string[] = [];
  while (end > 1 && isSlopLine(lines[end - 1]!)) {
    stripped.unshift(lines[end - 1]!);
    end -= 1;
  }
  if (stripped.length === 0) return { text, stripped };
  let out = lines.slice(0, end).join("\n");
  if (hadTrailingNl) out += "\n";
  return { text: out, stripped };
}

/**
 * Paired-replacement indent repair: when `oldText`/`newText` have the same
 * line count and every non-blank `newText` line is flat (column 0) while the
 * old side is indented, the model dropped indentation — copy each old line's
 * indent to its pair. New sides that already carry indent are left alone so
 * intentional re-indents survive.
 */
export function restorePairedIndent(oldText: string, newText: string): string {
  const oldLines = oldText.split("\n");
  const newLines = newText.split("\n");
  if (oldLines.length !== newLines.length || oldLines.length === 0) return newText;
  const allFlat = newLines.every((l) => l === "" || !/^[ \t]/.test(l));
  const someIndented = oldLines.some((l) => /^[ \t]+\S/.test(l));
  if (!allFlat || !someIndented) return newText;
  return newLines
    .map((nl, i) => {
      if (nl === "" || /^[ \t]/.test(nl)) return nl;
      return indentOf(oldLines[i] ?? "") + nl;
    })
    .join("\n");
}

export interface HunkAutocorrect {
  hunk: EditHunk;
  corrected: boolean;
  notes: string[];
}

/** Normalize one hunk: strip trailing slop from both sides, then repair indent. */
export function autocorrectHunk(hunk: EditHunk): HunkAutocorrect {
  const notes: string[] = [];
  let oldText = hunk.oldText;
  let newText = hunk.newText;
  const oldStripped = stripTrailingSlop(oldText);
  if (oldStripped.stripped.length > 0) {
    oldText = oldStripped.text;
    notes.push(`stripped ${oldStripped.stripped.length} trailing slop line(s) from oldText`);
  }
  const newStripped = stripTrailingSlop(newText);
  if (newStripped.stripped.length > 0) {
    newText = newStripped.text;
    notes.push(`stripped ${newStripped.stripped.length} trailing slop line(s) from newText`);
  }
  const restored = restorePairedIndent(oldText, newText);
  if (restored !== newText) {
    newText = restored;
    notes.push("restored indentation for paired replacement");
  }
  if (oldText.length === 0 || newText.length === 0 || notes.length === 0) {
    return { hunk, corrected: false, notes: notes.length === 0 ? notes : [] };
  }
  const out: EditHunk = { oldText, newText };
  if (hunk.replaceAll !== undefined) out.replaceAll = hunk.replaceAll;
  return { hunk: out, corrected: true, notes };
}

/**
 * Hash-anchored in effect, not just in name: `oldText` is the anchor. If it
 * doesn't appear in `content` (the file drifted since it was last read), or
 * appears more than once without `replaceAll` (ambiguous: which one?), the
 * edit is rejected outright rather than guessed at. This is the single
 * highest-value correctness property in the whole tools package: a rejected
 * edit is recoverable, a silently misapplied one corrupts the file.
 *
 * When the exact anchor is absent, a whitespace-tolerant fallback matches the
 * same text modulo indentation and whitespace-run differences (the dominant
 * file-drift shape), re-aligning the replacement's indentation to the matched
 * region. Content differences still reject — fuzzy means whitespace-tolerant,
 * never fuzzy about code.
 */
export function applyEdit(content: string, request: EditRequest): string {
  const normalized = autocorrectHunk(request).hunk;
  const oldText = normalized.oldText;
  const newText = normalized.newText;
  const replaceAll = normalized.replaceAll ?? request.replaceAll;
  if (oldText.length === 0) {
    throw editError("edit rejected: oldText must not be empty", { oldTextPreview: "" });
  }

  const occurrences = countOccurrences(content, oldText);

  if (occurrences === 0) {
    // Try hashline match (sha256 of each line, normalized for whitespace)
    const hashSpans = findAllHashAnchors(content, oldText);
    if (hashSpans.length > 0) {
      if (hashSpans.length > 1 && !replaceAll) {
        throw editError(t("tool.edit.ambiguous", { count: hashSpans.length }), {
          oldTextPreview: preview(oldText),
          occurrences: hashSpans.length,
          matchedBy: "hashline",
        });
      }

      let result = content;
      for (let i = hashSpans.length - 1; i >= 0; i--) {
        const span = hashSpans[i]!;
        const matchedText = content.slice(span.start, span.end);
        const replacement = buildFuzzyReplacement(matchedText, oldText, newText);
        result = result.slice(0, span.start) + replacement + result.slice(span.end);
      }
      return result;
    }

    // Fall back to whitespace-tolerant fuzzy match
    const fuzzy = fuzzyReplace(content, { oldText, newText, replaceAll });
    if (fuzzy !== undefined) return fuzzy;
    throw editError(t("tool.edit.not_found"), { oldTextPreview: preview(oldText) });
  }

  if (occurrences > 1 && !replaceAll) {
    throw editError(t("tool.edit.ambiguous", { count: occurrences }), {
      oldTextPreview: preview(oldText),
      occurrences,
    });
  }

  if (replaceAll) {
    return content.split(oldText).join(newText);
  }

  const index = content.indexOf(oldText);
  return content.slice(0, index) + newText + content.slice(index + oldText.length);
}

interface SpanMatch {
  start: number;
  end: number;
}

function isWordChar(ch: string | undefined): boolean {
  return ch !== undefined && /[A-Za-z0-9_]/.test(ch);
}

/**
 * Builds a whitespace-tolerant regex from `oldText`: per-line leading
 * whitespace becomes fully flexible (indentation normalization), internal
 * whitespace runs must still be whitespace (at least one when between two
 * word characters — so "return 1" never matches "return1" — otherwise zero
 * or more to tolerate "foo( 1 );" ↔ "foo(1);"), line endings tolerate \r\n,
 * and a trailing newline in the anchor is optional (EOF drift). Returns
 * undefined when nothing can flex.
 */
function whitespaceTolerantRegExp(oldText: string): RegExp | undefined {
  const lines = oldText.split("\n");
  const trailingEmpty = lines.length > 1 && lines[lines.length - 1] === "";
  const realLines = trailingEmpty ? lines.slice(0, -1) : lines;

  const lineSources: string[] = [];
  for (const [index, line] of realLines.entries()) {
    const isLast = index === realLines.length - 1;
    const withoutLeading = line.replace(/^[ \t]+/, "");
    let source = "[ \\t]*";
    let i = 0;
    while (i < withoutLeading.length) {
      const ch = withoutLeading[i]!;
      if (ch === " " || ch === "\t") {
        const before = withoutLeading[i - 1];
        let j = i;
        while (j < withoutLeading.length && (withoutLeading[j] === " " || withoutLeading[j] === "\t")) j++;
        const after = withoutLeading[j];
        const bothWord = isWordChar(before) && isWordChar(after);
        source += bothWord ? "[ \\t]+" : "[ \\t]*";
        i = j;
        continue;
      }
      source += escapeRegExpChar(ch);
      i++;
    }
    if (!isLast) source += "[ \\t]*";
    lineSources.push(source);
  }

  if (lineSources.length === 0) return undefined;
  // If every line is just flexible whitespace with no token, there is nothing to anchor
  if (lineSources.every((s) => s === "[ \\t]*" || s === "[ \\t]*[ \\t]*")) {
    const hasToken = realLines.some((l) => l.trim().length > 0);
    if (!hasToken) return undefined;
  }

  let source = lineSources.join("\\r?\\n");
  if (trailingEmpty) source = `${source}(?:\\r?\\n)?`;

  try {
    return new RegExp(source);
  } catch {
    return undefined;
  }
}

function escapeRegExpChar(ch: string): string {
  return ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function indentOf(line: string): string {
  return /^[ \t]*/.exec(line)?.[0] ?? "";
}

function matchAllSpans(content: string, re: RegExp): SpanMatch[] {
  const global = new RegExp(re.source, "g");
  const spans: SpanMatch[] = [];
  for (const match of content.matchAll(global)) {
    if (match.index === undefined) continue;
    // Guard against zero-length matches which would loop infinitely
    if (match[0].length === 0) continue;
    spans.push({ start: match.index, end: match.index + match[0].length });
  }
  return spans;
}

function toRealLines(text: string): string[] {
  const lines = text.split(/\r?\n/);
  if (text.endsWith("\n") && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

function parseLineTokens(line: string): { leading: string; tokens: string[]; seps: string[] } {
  const leading = indentOf(line);
  const rest = line.slice(leading.length);
  if (rest.length === 0) return { leading, tokens: [], seps: [] };
  const seps = rest.match(/[ \t]+/g) ?? [];
  const tokens = rest.split(/[ \t]+/);
  // split produces trailing "" if rest ends with whitespace (e.g. "a  " -> ["a",""])
  if (tokens.length > 0 && tokens[tokens.length - 1] === "") tokens.pop();
  return { leading, tokens, seps };
}

function buildFuzzyReplacement(matchedText: string, oldText: string, newText: string): string {
  const matchedReal = toRealLines(matchedText);
  const oldReal = toRealLines(oldText);
  const newReal = toRealLines(newText);

  const outLines: string[] = [];
  for (let i = 0; i < newReal.length; i++) {
    const newLine = newReal[i] ?? "";
    const oldLine = oldReal[i] ?? oldReal[oldReal.length - 1] ?? "";
    const matchedLine = matchedReal[i] ?? matchedReal[matchedReal.length - 1] ?? "";

    const oldParsed = parseLineTokens(oldLine);
    const newParsed = parseLineTokens(newLine);
    const matchedParsed = parseLineTokens(matchedLine);

    const canPreserve =
      oldParsed.tokens.length > 0 &&
      oldParsed.tokens.length === newParsed.tokens.length &&
      oldParsed.tokens.length === matchedParsed.tokens.length;

    if (canPreserve) {
      let rebuilt = matchedParsed.leading + (newParsed.tokens[0] ?? "");
      for (let j = 0; j < matchedParsed.seps.length && j < newParsed.tokens.length - 1; j++) {
        rebuilt += matchedParsed.seps[j]! + (newParsed.tokens[j + 1] ?? "");
      }
      // If matched had trailing whitespace and new did not, ignore trailing
      outLines.push(rebuilt);
    } else {
      const trimmed = newLine.trimStart();
      if (trimmed.length === 0) {
        outLines.push("");
      } else {
        const targetLeading = matchedParsed.leading;
        outLines.push(targetLeading + trimmed);
      }
    }
  }

  let result = outLines.join("\n");
  if (newText.endsWith("\n") && !result.endsWith("\n")) result += "\n";
  return result;
}

/**
 * The whitespace-tolerant fallback: matches the anchor modulo whitespace
 * differences and re-aligns the replacement's indentation to the matched
 * region, preserving internal whitespace runs from the original when the
 * token structure aligns. Returns undefined when nothing matches fuzzily
 * either.
 */
function fuzzyReplace(content: string, request: EditRequest): string | undefined {
  const pattern = whitespaceTolerantRegExp(request.oldText);
  if (!pattern) return undefined;

  const spans = matchAllSpans(content, pattern);
  if (spans.length === 0) return undefined;
  if (spans.length > 1 && !request.replaceAll) {
    throw editError(t("tool.edit.ambiguous", { count: spans.length }), {
      oldTextPreview: preview(request.oldText),
      occurrences: spans.length,
      matchedFuzzily: true,
    });
  }

  let result = content;
  for (let i = spans.length - 1; i >= 0; i--) {
    const span = spans[i]!;
    const matchedText = content.slice(span.start, span.end);
    const replacement = buildFuzzyReplacement(matchedText, request.oldText, request.newText);
    result = result.slice(0, span.start) + replacement + result.slice(span.end);
  }
  return result;
}
