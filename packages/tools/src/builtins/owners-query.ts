import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { scopeMatchesPattern } from "@agency/guard";

export interface OwnerRuleLike {
  pattern: string;
  handles: string[];
}

export function parseOwnersRules(text: string): OwnerRuleLike[] {
  const rules: OwnerRuleLike[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.length === 0 || line.startsWith("#")) continue;
    const parts = line.split(/\s+/);
    const pattern = parts[0];
    if (pattern === undefined || parts.length < 2) continue;
    rules.push({ pattern, handles: parts.slice(1).map((h) => (h.startsWith("@") ? h.slice(1) : h)) });
  }
  return rules;
}

export function ownersForPath(rules: readonly OwnerRuleLike[], candidate: string): string[] {
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

export function loadOwnersFile(workspaceRoot: string, override?: string): OwnerRuleLike[] {
  const file = override ?? join(workspaceRoot, ".agency", "owners");
  if (!existsSync(file)) return [];
  try {
    return parseOwnersRules(readFileSync(file, "utf8"));
  } catch {
    return [];
  }
}
