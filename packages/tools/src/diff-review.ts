import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { AgencyError, ErrorCode } from "@agency/schema";
import { commentsPath } from "./builtins/plan.ts";
import { parseUnifiedHunkHeader, type UnifiedDiffOptions, unifiedDiff } from "./hashline.ts";
import { sliceAtCharBoundary } from "./truncate.ts";

/**
 * Diff-level review helpers: line-numbered unified rendering, inline
 * comments on a diff target, and diff-scoped approval records.
 *
 * Comments reuse the plan.ts stub file (`commentsPath()` →
 * `<target>.comments.json`, shape `{ comments?: Array<{ resolved? }> }`)
 * so the future inline-commenting UI reads one format everywhere.
 * Approvals here are diff-level records only — ApprovalManager is untouched.
 */

/** Byte cap for rendered diffs (matches the bash tool's 30_000-byte cap). */
export const MAX_DIFF_BYTES = 30_000;

/** Line cap for rendered diff bodies (hunk headers excluded). */
export const MAX_DIFF_LINES = 200;

export type SideBySideOptions = UnifiedDiffOptions;

function diffError(message: string, context: Record<string, unknown>): AgencyError {
  return new AgencyError(ErrorCode.TOOL_ERROR, message, { source: "diff-review", context });
}

/**
 * Renders `before` → `after` as a unified diff with old/new line numbers.
 * Returns "" when the texts are identical (same convention as
 * `unifiedDiff`). Output is capped at 200 body lines and 30_000 bytes;
 * overflow is cut with a trailing notice, never silently dropped.
 */
export function renderSideBySide(before: string, after: string, opts?: SideBySideOptions): string {
  const diff = unifiedDiff(before, after, opts);
  if (diff === "") return "";
  const lines = diff.split("\n");
  // unifiedDiff ends with "\n": the trailing "" is a terminator, not a line.
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  const header = lines.slice(0, 2);
  const body = lines.slice(2);

  // Width for the line-number columns, from the largest numbers referenced.
  let maxNo = 1;
  for (const line of body) {
    if (!line.startsWith("@@")) continue;
    const parsed = parseUnifiedHunkHeader(line);
    if (parsed) maxNo = Math.max(maxNo, parsed.oldStart + parsed.oldCount, parsed.newStart + parsed.newCount);
  }
  const width = Math.max(4, String(maxNo).length);
  const oldNo = (n: number | undefined): string =>
    n === undefined ? " ".repeat(width) : String(n).padStart(width, " ");
  const newNo = (n: number | undefined): string =>
    n === undefined ? " ".repeat(width) : String(n).padStart(width, " ");

  const rendered: string[] = [...header];
  let emitted = 0;
  let truncated = 0;
  let oldCursor = 0;
  let newCursor = 0;
  for (const line of body) {
    if (line.startsWith("@@")) {
      const parsed = parseUnifiedHunkHeader(line);
      if (parsed) {
        oldCursor = parsed.oldCount === 0 ? parsed.oldStart + 1 : parsed.oldStart;
        newCursor = parsed.newCount === 0 ? parsed.newStart + 1 : parsed.newStart;
      }
      rendered.push(line);
      continue;
    }
    const marker = line[0] === "-" ? "-" : line[0] === "+" ? "+" : " ";
    const content = line.slice(1);
    const oldLine = marker === "-" || marker === " " ? oldCursor : undefined;
    const newLine = marker === "+" || marker === " " ? newCursor : undefined;
    if (oldLine !== undefined) oldCursor += 1;
    if (newLine !== undefined) newCursor += 1;
    if (emitted >= MAX_DIFF_LINES) {
      truncated += 1;
      continue;
    }
    rendered.push(`${oldNo(oldLine)} ${newNo(newLine)} | ${marker} ${content}`);
    emitted += 1;
  }
  if (truncated > 0) {
    rendered.push(`... [truncated: ${truncated} more line(s), ${MAX_DIFF_LINES}-line cap]`);
  }
  let out = `${rendered.join("\n")}\n`;
  if (Buffer.byteLength(out, "utf8") > MAX_DIFF_BYTES) {
    const head = sliceAtCharBoundary(Buffer.from(out, "utf8"), MAX_DIFF_BYTES);
    out = `${head}\n... [truncated: output exceeds ${MAX_DIFF_BYTES} bytes]`;
  }
  return out;
}

// ── Diff comments (plan.ts `.comments.json` format) ─────────────────────────

export interface DiffComment {
  id: string;
  /** 1-based new-side line the comment anchors to, when line-scoped. */
  line?: number;
  text: string;
  author: string;
  resolved: boolean;
  createdAt: string;
}

function isDiffComment(value: unknown): value is DiffComment {
  if (typeof value !== "object" || value === null) return false;
  const c = value as Record<string, unknown>;
  return (
    typeof c.id === "string" &&
    typeof c.text === "string" &&
    typeof c.resolved === "boolean" &&
    (c.line === undefined || (typeof c.line === "number" && Number.isInteger(c.line) && c.line >= 1)) &&
    (c.author === undefined || typeof c.author === "string") &&
    (c.createdAt === undefined || typeof c.createdAt === "string")
  );
}

function readCommentsFile(targetPath: string): DiffComment[] {
  const file = commentsPath(targetPath);
  if (!existsSync(file)) return [];
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
    if (typeof parsed !== "object" || parsed === null) return [];
    const comments = (parsed as { comments?: unknown }).comments;
    if (!Array.isArray(comments)) return [];
    return comments.filter(isDiffComment).map((c) => ({ ...c, author: c.author ?? "user" }));
  } catch {
    return [];
  }
}

function writeCommentsFile(targetPath: string, comments: DiffComment[]): void {
  const file = commentsPath(targetPath);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ comments }, null, 2), "utf8");
}

/** All comments on a diff target, in insertion order ([] when none/corrupt). */
export function listDiffComments(targetPath: string): DiffComment[] {
  return readCommentsFile(targetPath);
}

/** Appends an unresolved comment to the target's `.comments.json` file. */
export function addDiffComment(
  targetPath: string,
  comment: { text: string; line?: number; author?: string },
): DiffComment {
  const text = comment.text.trim();
  if (text.length === 0) throw diffError("diff comment requires non-empty text", { targetPath });
  if (comment.line !== undefined && (!Number.isInteger(comment.line) || comment.line < 1)) {
    throw diffError("diff comment line must be a positive integer", { targetPath });
  }
  const entry: DiffComment = {
    id: randomUUID(),
    ...(comment.line === undefined ? {} : { line: comment.line }),
    text,
    author: comment.author ?? "user",
    resolved: false,
    createdAt: new Date().toISOString(),
  };
  const comments = readCommentsFile(targetPath);
  comments.push(entry);
  writeCommentsFile(targetPath, comments);
  return entry;
}

/** Marks one comment resolved; true when the id existed. */
export function resolveDiffComment(targetPath: string, commentId: string): boolean {
  const comments = readCommentsFile(targetPath);
  const found = comments.find((c) => c.id === commentId);
  if (!found) return false;
  found.resolved = true;
  writeCommentsFile(targetPath, comments);
  return true;
}

export interface ReviewFinding {
  text: string;
  line?: number;
}

// Reviewer findings land as diff comments on the reviewed target,
// so the lead integrates findings, not prose about the diff.
export function appendReviewFindings(
  targetPath: string,
  findings: readonly ReviewFinding[],
  author: string,
): DiffComment[] {
  return findings.map((finding) =>
    addDiffComment(
      targetPath,
      finding.line === undefined
        ? { text: finding.text, author }
        : { text: finding.text, line: finding.line, author },
    ),
  );
}

/**
 * How many comments on this diff target are still unresolved, 0 when
 * none/absent/corrupt — same semantics and file as plan.ts
 * `countUnresolvedComments`, so plan and diff gates agree.
 */
export function countUnresolvedComments(targetPath: string): number {
  return readCommentsFile(targetPath).filter((c) => !c.resolved).length;
}

// ── Diff-level approvals (record only; ApprovalManager untouched) ────────────

export interface DiffApprovalRecord {
  /** The reviewed diff's identity (e.g. plan path, change id). */
  id: string;
  /** sha256 of the exact diff text that was approved. */
  hash: string;
  approvedBy: string;
  approvedAt: string;
}

/** Creates the approval record for an exact diff text (pure: no I/O). */
export function createDiffApproval(id: string, diff: string, approver = "user"): DiffApprovalRecord {
  if (id.trim().length === 0) throw diffError("diff approval requires a non-empty id", {});
  if (diff.length === 0) throw diffError("diff approval requires a non-empty diff", { id });
  if (approver.trim().length === 0) throw diffError("diff approval requires a non-empty approver", { id });
  return {
    id,
    hash: createHash("sha256").update(diff, "utf8").digest("hex"),
    approvedBy: approver,
    approvedAt: new Date().toISOString(),
  };
}

/** Diff gate outcome. Uses the plan gate vocabulary on purpose. */
export type DiffGateReason = "pass-clean" | "fail-unresolved-comments";

/** Gate decision for a diff target: pass flag plus reason and count. */
export interface DiffGateDecision {
  pass: boolean;
  reason: DiffGateReason;
  unresolved: number;
}

/** Evaluate the comment gate for a diff target. Passes when none unresolved. */
export function evaluateDiffGate(targetPath: string): DiffGateDecision {
  const unresolved = countUnresolvedComments(targetPath);
  if (unresolved > 0) return { pass: false, reason: "fail-unresolved-comments", unresolved };
  return { pass: true, reason: "pass-clean", unresolved };
}

/** User-facing one-line rendering of a diff gate decision. Keeps the reason. */
export function formatDiffGateForDisplay(decision: DiffGateDecision): string {
  const verdict = decision.pass ? "passed" : "blocked";
  return `diff gate ${verdict} [${decision.reason}]: ${decision.unresolved} unresolved comment(s)`;
}

/** Approve an exact diff text, refusing while comments stay unresolved. */
export function approveDiffWithComments(
  id: string,
  diff: string,
  targetPath: string,
  approver = "user",
): DiffApprovalRecord {
  const gate = evaluateDiffGate(targetPath);
  if (!gate.pass) {
    throw diffError(
      `cannot approve diff: ${gate.unresolved} unresolved comment(s): resolve them before approving`,
      { id },
    );
  }
  return createDiffApproval(id, diff, approver);
}
