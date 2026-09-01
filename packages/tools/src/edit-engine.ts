import { AgencyError, ErrorCode } from "@agency/schema";

export interface EditRequest {
  oldText: string;
  newText: string;
  /** Explicit opt-in to replace every occurrence (renames), instead of the
   *  default single-occurrence requirement. */
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

/**
 * Hash-anchored in effect, not just in name: `oldText` is the anchor. If it
 * doesn't appear in `content` (the file drifted since it was last read), or
 * appears more than once without `replaceAll` (ambiguous: which one?), the
 * edit is rejected outright rather than guessed at. This is the single
 * highest-value correctness property in the whole tools package: a rejected
 * edit is recoverable, a silently misapplied one corrupts the file.
 */
export function applyEdit(content: string, request: EditRequest): string {
  const occurrences = countOccurrences(content, request.oldText);

  if (occurrences === 0) {
    throw new AgencyError(
      ErrorCode.TOOL_ERROR,
      "edit rejected: the expected text was not found, the file has changed since it was last read",
      { source: "edit", context: { oldTextPreview: preview(request.oldText) } },
    );
  }

  if (occurrences > 1 && !request.replaceAll) {
    throw new AgencyError(
      ErrorCode.TOOL_ERROR,
      `edit rejected: the expected text appears ${occurrences} times, include more surrounding context to make it unique, or pass replaceAll`,
      { source: "edit", context: { oldTextPreview: preview(request.oldText), occurrences } },
    );
  }

  if (request.replaceAll) {
    return content.split(request.oldText).join(request.newText);
  }

  const index = content.indexOf(request.oldText);
  return content.slice(0, index) + request.newText + content.slice(index + request.oldText.length);
}

function preview(text: string): string {
  return text.length > 200 ? `${text.slice(0, 200)}…` : text;
}
