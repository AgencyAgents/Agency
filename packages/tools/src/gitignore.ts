import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { globToRegExpSource } from "@agency/guard";

interface IgnoreRule {
  negated: boolean;
  test: (relPath: string) => boolean;
}

function compile(glob: string): RegExp {
  return new RegExp(globToRegExpSource(glob, "path"));
}

/**
 * One .gitignore line → a matcher over workspace-relative forward-slash
 * paths. Covers the common grammar: comments, negation (`!`), trailing-slash
 * directory patterns, anchored (contains `/`) vs basename patterns, and
 * `*`/`**`/`?` globs via guard's glob compiler. Escaped characters and
 * nested-directory .gitignore files are out of scope for this simple pass.
 */
export function parseGitignoreLine(line: string): IgnoreRule | undefined {
  const trimmed = line.replace(/\s+$/, "").trim();
  if (trimmed.length === 0 || trimmed.startsWith("#")) return undefined;

  let pattern = trimmed;
  let negated = false;
  if (pattern.startsWith("!")) {
    negated = true;
    pattern = pattern.slice(1);
    if (pattern.length === 0) return undefined;
  }

  const dirOnly = pattern.endsWith("/");
  if (dirOnly) pattern = pattern.slice(0, -1);
  if (pattern.length === 0) return undefined;

  const anchored = pattern.includes("/");
  if (anchored) {
    const stripped = pattern.startsWith("/") ? pattern.slice(1) : pattern;
    const exact = compile(stripped);
    const under = compile(`${stripped}/**`);
    return { negated, test: (rel) => exact.test(rel) || under.test(rel) };
  }

  const segment = compile(pattern);
  return { negated, test: (rel) => rel.split("/").some((part) => segment.test(part)) };
}

/**
 * Loads `<dir>/.gitignore` and returns a predicate answering "is this
 * workspace-relative path ignored". Later matching lines win (git's
 * negation semantics). Returns undefined when no .gitignore exists or it
 * holds no usable rules — callers then filter nothing.
 */
export function loadGitignore(dir: string): ((relPath: string) => boolean) | undefined {
  const file = join(dir, ".gitignore");
  if (!existsSync(file)) return undefined;

  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return undefined;
  }

  const rules = text
    .split(/\r?\n/)
    .map(parseGitignoreLine)
    .filter((rule): rule is IgnoreRule => rule !== undefined);
  if (rules.length === 0) return undefined;

  return (relPath: string) => {
    const normalized = relPath.replace(/\\/g, "/");
    let ignored = false;
    for (const rule of rules) {
      if (rule.test(normalized)) ignored = !rule.negated;
    }
    return ignored;
  };
}
