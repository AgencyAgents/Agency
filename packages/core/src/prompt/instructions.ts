import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { TrustStore } from "@agency/guard";
import { requireTrust } from "@agency/guard";

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
    dir = parent;
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
 * Loads project instructions (AGENTS.md nearest-first, then `.agency/rules/*`),
 * throwing PERMISSION_DENIED if `workspaceRoot` hasn't been explicitly
 * trusted. AGENTS.md is repo-provided content and therefore an injection
 * surface (R2); it must never reach the prompt before that gate passes.
 */
export function loadInstructions(
  trustStore: TrustStore,
  workspaceRoot: string,
  fromDir: string = workspaceRoot,
): string[] {
  requireTrust(trustStore, workspaceRoot);
  const files = [...collectAgentsFiles(fromDir, workspaceRoot), ...collectRuleFiles(workspaceRoot)];
  return files.map((f) => readFileSync(f, "utf8"));
}
