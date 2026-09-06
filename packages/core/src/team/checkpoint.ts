import { existsSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { scopeMatchesPattern } from "@agency/guard";

/** Upper bound on files one checkpoint captures, so a broad scope cannot balloon it. */
export const CHECKPOINT_FILE_CAP = 200;

export interface IntegrationCheckpoint {
  files: Record<string, string | null>;
  at: string;
}

function walkFiles(root: string, out: string[]): void {
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry === ".git" || entry === "node_modules" || entry === ".agency") continue;
    const full = join(root, entry);
    let isDir = false;
    try {
      isDir = statSync(full).isDirectory();
    } catch {
      continue;
    }
    if (isDir) walkFiles(full, out);
    else if (out.length < CHECKPOINT_FILE_CAP) out.push(full);
  }
}

// Resolves item path scopes to existing workspace files, so the
// checkpoint captures exactly what integration is about to overwrite.
export function resolveScopeFiles(workspaceRoot: string, scopes: readonly string[]): string[] {
  const all: string[] = [];
  walkFiles(workspaceRoot, all);
  const rel = (abs: string): string => relative(workspaceRoot, abs).replace(/\\/g, "/");
  return all.filter((abs) => scopes.some((scope) => scopeMatchesPattern(scope, rel(abs))));
}

// Pre-merge capture: every listed file's bytes, or null when the
// file is absent, so undo can delete what integration created.
export function recordIntegrationCheckpoint(paths: readonly string[]): IntegrationCheckpoint {
  const files: Record<string, string | null> = {};
  for (const abs of paths.slice(0, CHECKPOINT_FILE_CAP)) {
    try {
      files[abs] = existsSync(abs) ? readFileSync(abs, "utf8") : null;
    } catch {
      files[abs] = null;
    }
  }
  return { files, at: new Date().toISOString() };
}

// Whole-run undo: restores captured bytes and removes files that
// did not exist before integration ran.
export function restoreIntegrationCheckpoint(checkpoint: IntegrationCheckpoint): { restored: string[] } {
  const restored: string[] = [];
  for (const [abs, content] of Object.entries(checkpoint.files)) {
    try {
      if (content === null) {
        try {
          unlinkSync(abs);
        } catch {
          // Absent already: nothing to remove.
        }
      } else {
        writeFileSync(abs, content, "utf8");
      }
      restored.push(abs);
    } catch {
      // Best-effort per file: one locked file must not block the rest.
    }
  }
  return { restored };
}
