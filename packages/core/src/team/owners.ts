import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { scopeMatchesPattern } from "@agency/guard";

export interface OwnerRule {
  pattern: string;
  handles: string[];
}

export function parseOwnersFile(text: string): OwnerRule[] {
  const rules: OwnerRule[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.length === 0 || line.startsWith("#")) continue;
    const parts = line.split(/\s+/);
    const pattern = parts[0];
    if (pattern === undefined || parts.length < 2) continue;
    const handles = parts.slice(1).map((h) => (h.startsWith("@") ? h.slice(1) : h));
    rules.push({ pattern, handles });
  }
  return rules;
}

export function ownersForPath(rules: readonly OwnerRule[], candidate: string): string[] {
  const path = candidate.replace(/\\/g, "/");
  const out: string[] = [];
  for (const rule of rules) {
    if (scopeMatchesPattern(rule.pattern, path)) {
      for (const handle of rule.handles) {
        if (!out.includes(handle)) out.push(handle);
      }
    }
  }
  return out;
}

export function ownersFilePath(workspaceRoot: string): string {
  return join(workspaceRoot, ".agency", "owners");
}

export function loadOwnersFile(workspaceRoot: string): OwnerRule[] {
  const file = ownersFilePath(workspaceRoot);
  if (!existsSync(file)) return [];
  try {
    return parseOwnersFile(readFileSync(file, "utf8"));
  } catch {
    return [];
  }
}
