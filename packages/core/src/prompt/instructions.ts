import { closeSync, existsSync, openSync, readdirSync, readSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { TrustStore } from "@agency/guard";
import { requireTrust } from "@agency/guard";

/** Per-instruction-file read cap. AGENTS.md is repo-controlled content, so a
 *  multi-gigabyte file (malicious or accidental) would otherwise blow the
 *  prompt — and the daemon's memory — through an unbounded read. */
export const DEFAULT_MAX_INSTRUCTION_BYTES = 64 * 1024;

export interface LoadInstructionsOptions {
  /** Per-file byte cap; defaults to `DEFAULT_MAX_INSTRUCTION_BYTES`. Files
   *  larger than this are truncated at a UTF-8 character boundary with a
   *  visible notice appended, never silently. */
  maxFileBytes?: number;
}

/** Walks from `fromDir` up to `workspaceRoot`, nearest directory first: a
 *  monorepo package's own AGENTS.md should win over the repo root's, since
 *  composeSystemPrompt appends instructions in the order given here. */
export function collectAgentsFiles(fromDir: string, workspaceRoot: string): string[] {
  const found: string[] = [];
  let dir = fromDir;
  for (;;) {
    const candidate = join(dir, "AGENTS.md");
    if (existsSync(candidate)) found.push(candidate);
    if (dir === workspaceRoot) break;
    const parent = dirname(dir);
    if (parent === dir) break;
    if (dir.length < workspaceRoot.length && !workspaceRoot.startsWith(dir)) break;
    dir = parent;
    if (dir.length < workspaceRoot.length) {
      const cand2 = join(workspaceRoot, "AGENTS.md");
      if (existsSync(cand2) && !found.includes(cand2)) found.push(cand2);
      break;
    }
  }
  return found;
}

export function collectRuleFiles(workspaceRoot: string): string[] {
  const rulesDir = join(workspaceRoot, ".agency", "rules");
  if (!existsSync(rulesDir)) return [];
  return readdirSync(rulesDir)
    .filter((f) => f.endsWith(".md"))
    .sort()
    .map((f) => join(rulesDir, f));
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
 * Loads project instructions (AGENTS.md nearest-first, then `.agency/rules/*`),
 * throwing PERMISSION_DENIED if `workspaceRoot` hasn't been explicitly
 * trusted. AGENTS.md is repo-provided content and therefore an injection
 * surface (R2); it must never reach the prompt before that gate passes.
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
  return files.map((f) => readTextCapped(f, maxFileBytes));
}
