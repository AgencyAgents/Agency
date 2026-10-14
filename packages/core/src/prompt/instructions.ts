import { closeSync, existsSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { TrustStore } from "@agency/guard";
import { requireTrust } from "@agency/guard";
import { splitFrontmatter } from "../plugins/skill.ts";

/** The instruction files of a folder, in this order: those of Codex and Pi, Claude Code, and Gemini CLI. */
const INSTRUCTION_NAMES = ["AGENTS.md", "CLAUDE.md", "GEMINI.md"];

/** Per-instruction-file read cap. AGENTS.md / CLAUDE.md is repo-controlled
 *  content, so a multi-gigabyte file (malicious or accidental) would otherwise
 *  blow the prompt — and the daemon's memory — through an unbounded read. */
export const DEFAULT_MAX_INSTRUCTION_BYTES = 64 * 1024;

export interface LoadInstructionsOptions {
  /** Per-file byte cap; defaults to `DEFAULT_MAX_INSTRUCTION_BYTES`. Files
   *  larger than this are truncated at a UTF-8 character boundary with a
   *  visible notice appended, never silently. */
  maxFileBytes?: number;
}

/** Walks from `fromDir` up to `workspaceRoot`, nearest directory first: a
 *  monorepo package's own AGENTS.md should win over the repo root's, since
 *  composeSystemPrompt appends instructions in the order given here. In each
 *  directory AGENTS.md is checked first, then CLAUDE.md — when both exist the
 *  caller sees AGENTS.md before CLAUDE.md (documented precedence). */
export function collectAgentsFiles(fromDir: string, workspaceRoot: string): string[] {
  const found: string[] = [];
  let dir = fromDir;
  for (;;) {
    for (const name of INSTRUCTION_NAMES) {
      const file = join(dir, name);
      if (existsSync(file)) found.push(file);
    }
    if (dir === workspaceRoot) break;
    const parent = dirname(dir);
    if (parent === dir) break;
    if (dir.length < workspaceRoot.length && !workspaceRoot.startsWith(dir)) break;
    dir = parent;
    if (dir.length < workspaceRoot.length) {
      for (const name of INSTRUCTION_NAMES) {
        const file = join(workspaceRoot, name);
        if (existsSync(file) && !found.includes(file)) found.push(file);
      }
      break;
    }
  }
  return found;
}

/** The files of `dir` and its subfolders that end with `ext`, sorted. */
function filesIn(dir: string, ext: string): string[] {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return [];
  return readdirSync(dir, { recursive: true, encoding: "utf8" })
    .filter((f) => f.endsWith(ext))
    .sort()
    .map((f) => join(dir, f));
}

/** The rule files of other agents (Cursor, Windsurf, Cline, Copilot), then `.agency/rules/*.md`. */
export function collectRuleFiles(workspaceRoot: string): string[] {
  const single = [".cursorrules", ".windsurfrules", ".clinerules", join(".github", "copilot-instructions.md")]
    .map((name) => join(workspaceRoot, name))
    .filter((file) => existsSync(file) && statSync(file).isFile());
  return [
    ...single,
    ...filesIn(join(workspaceRoot, ".clinerules"), ".md"),
    ...filesIn(join(workspaceRoot, ".cursor", "rules"), ".mdc"),
    ...filesIn(join(workspaceRoot, ".agency", "rules"), ".md"),
  ];
}

/** A Cursor rule as instruction text: its frontmatter says when it applies. A rule that only `@name` calls is left out. */
export function cursorRuleText(text: string): string {
  const { fields, body } = splitFrontmatter(text);
  const field = (name: string) => fields[name]?.replace(/^["']|["']$/g, "");
  if (field("alwaysApply") === "true") return body.trim();
  if (field("globs")) return `Files that match ${field("globs")}:\n${body.trim()}`;
  if (field("description")) return `When the task is about: ${field("description")}\n${body.trim()}`;
  return "";
}

/**
 * Reads at most `maxBytes + 1` bytes from disk — the cap applies to the I/O
 * itself, not just to a post-hoc slice of an unbounded read. When the file is
 * larger, the cut backs up over UTF-8 continuation bytes so no character is
 * split, and a visible notice marks the truncation.
 */
function readTextCapped(file: string, maxBytes: number): string {
  const fd = openSync(file, "r");
  try {
    const buf = Buffer.alloc(maxBytes + 1);
    const bytesRead = readSync(fd, buf, 0, maxBytes + 1, 0);
    if (bytesRead <= maxBytes) return buf.toString("utf8", 0, bytesRead);
    let end = maxBytes;
    while (end > 0 && ((buf[end] ?? 0) & 0xc0) === 0x80) end -= 1;
    const content = buf.toString("utf8", 0, end);
    return `${content}\n\n[instruction file truncated to ${maxBytes} bytes: ${basename(file)}]`;
  } finally {
    closeSync(fd);
  }
}

/**
 * Loads project instructions (AGENTS.md + CLAUDE.md nearest-first, then
 * `.agency/rules/*`), throwing PERMISSION_DENIED if `workspaceRoot` hasn't
 * been explicitly trusted. AGENTS.md / CLAUDE.md is repo-provided content and
 * therefore an injection surface (R2); it must never reach the prompt before
 * that gate passes.
 */
export function loadInstructions(
  trustStore: TrustStore,
  workspaceRoot: string,
  fromDir?: string,
  options: LoadInstructionsOptions = {},
): string[] {
  requireTrust(trustStore, workspaceRoot);
  const maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_INSTRUCTION_BYTES;
  const effectiveFromDir =
    fromDir ??
    (() => {
      try {
        const cwd = process.cwd();
        return cwd.startsWith(workspaceRoot) ? cwd : workspaceRoot;
      } catch {
        return workspaceRoot;
      }
    })();
  const files = [...collectAgentsFiles(effectiveFromDir, workspaceRoot), ...collectRuleFiles(workspaceRoot)];
  const texts = files.map((f) => {
    const text = readTextCapped(f, maxFileBytes);
    return f.endsWith(".mdc") ? cursorRuleText(text) : text;
  });
  // A CLAUDE.md that repeats AGENTS.md (a copy or a link) counts once.
  return texts.filter((text, index) => text.trim() !== "" && texts.indexOf(text) === index);
}
