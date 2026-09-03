import { AgencyError, ErrorCode } from "@agency/schema";
import { t } from "@agency/i18n";

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
 * Multi-hunk form of applyEditVerified: applies every hunk in order against
 * the working copy, then reads diagnostics once. All-or-nothing falls out of
 * applyEdit's throw-on-reject — a rejected hunk discards the working copy and
 * the caller never writes a partially-edited file.
 */
export function applyEditsVerified(
  content: string,
  hunks: readonly EditHunk[],
  options?: { path?: string; diagnostics?: DiagnosticsProvider },
): EditVerificationResult {
  let current = content;
  for (const hunk of hunks) current = applyEdit(current, hunk);
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
  if (request.oldText.length === 0) {
    throw editError("edit rejected: oldText must not be empty", { oldTextPreview: "" });
  }

  const occurrences = countOccurrences(content, request.oldText);

  if (occurrences === 0) {
    const fuzzy = fuzzyReplace(content, request);
    if (fuzzy !== undefined) return fuzzy;
    throw editError(t("tool.edit.not_found"), { oldTextPreview: preview(request.oldText) });
  }

  if (occurrences > 1 && !request.replaceAll) {
    throw editError(t("tool.edit.ambiguous", { count: occurrences }), {
      oldTextPreview: preview(request.oldText),
      occurrences,
    });
  }

  if (request.replaceAll) {
    return content.split(request.oldText).join(request.newText);
  }

  const index = content.indexOf(request.oldText);
  return content.slice(0, index) + request.newText + content.slice(index + request.oldText.length);
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
