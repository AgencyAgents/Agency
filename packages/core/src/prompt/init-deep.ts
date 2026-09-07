import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, join, relative } from "node:path";

export const INIT_DEEP_FILE_NAME = "AGENTS.md";
export const INIT_DEEP_MAX_DIRS = 100;
export const INIT_DEEP_MAX_DEPTH = 6;

const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  ".omo",
  ".agency",
  "coverage",
  ".next",
  ".turbo",
]);

export interface InitDeepTemplateVars {
  dirRel: string;
  dirName: string;
  isRoot: boolean;
  children: string[];
}

export const AGENTS_MD_TEMPLATE = `# AGENTS.md - {{DIR_LABEL}}

Scope: this file applies to {{SCOPE}} and its subdirectories unless a nearer AGENTS.md overrides it.
Parent files still apply; the nearer file wins on conflict (nearest-directory-first order).

## What lives here

- Purpose: {{PURPOSE_HINT}}
- Key entries: {{CHILDREN_HINT}}

## Conventions

- Keep changes scoped to this directory; do not leak unrelated edits outward.
- Match the surrounding code style; prefer surgical edits over refactors.
- Update this file when the directory's purpose or entry points change.

## Verification

- Run the narrowest relevant tests before claiming done.
`;

export function renderAgentsTemplate(vars: InitDeepTemplateVars): string {
  const label = vars.isRoot ? "project root" : vars.dirRel;
  const scope = vars.isRoot ? "the whole project" : `\`${vars.dirRel}\``;
  const childrenHint =
    vars.children.length > 0 ? vars.children.join(", ") : "(fill in: key files or subpackages)";
  return AGENTS_MD_TEMPLATE.replace("{{DIR_LABEL}}", label)
    .replace("{{SCOPE}}", scope)
    .replace("{{PURPOSE_HINT}}", vars.isRoot ? "project-wide rules" : `rules for \`${vars.dirRel}\``)
    .replace("{{CHILDREN_HINT}}", childrenHint);
}

export interface DiscoverInitDeepOptions {
  maxDirs?: number;
  maxDepth?: number;
}

export function discoverInitDeepDirs(workspaceRoot: string, options: DiscoverInitDeepOptions = {}): string[] {
  const maxDirs = options.maxDirs ?? INIT_DEEP_MAX_DIRS;
  const maxDepth = options.maxDepth ?? INIT_DEEP_MAX_DEPTH;
  const out: string[] = [workspaceRoot];
  const queue: Array<{ dir: string; depth: number }> = [{ dir: workspaceRoot, depth: 0 }];
  while (queue.length > 0 && out.length < maxDirs) {
    const current = queue.shift();
    if (!current || current.depth >= maxDepth) continue;
    let entries: string[] = [];
    try {
      entries = readdirSync(current.dir);
    } catch {
      continue;
    }
    for (const entry of entries.sort()) {
      if (out.length >= maxDirs) break;
      if (entry.startsWith(".")) continue;
      if (SKIP_DIRS.has(entry)) continue;
      const full = join(current.dir, entry);
      let isDir = false;
      try {
        isDir = statSync(full).isDirectory();
      } catch {
        continue;
      }
      if (!isDir) continue;
      out.push(full);
      queue.push({ dir: full, depth: current.depth + 1 });
    }
  }
  return out;
}

export interface GenerateAgentsMdResult {
  path: string;
  created: boolean;
}

export function generateAgentsMd(dir: string, options: { force?: boolean } = {}): GenerateAgentsMdResult {
  const path = join(dir, INIT_DEEP_FILE_NAME);
  if (existsSync(path) && !options.force) return { path, created: false };
  let children: string[] = [];
  try {
    children = readdirSync(dir)
      .filter((e) => !e.startsWith("."))
      .sort()
      .slice(0, 20);
  } catch {
    children = [];
  }
  const content = renderAgentsTemplate({
    dirRel: basename(dir),
    dirName: basename(dir),
    isRoot: false,
    children,
  });
  mkdirSync(dir, { recursive: true });
  writeFileSync(path, content, "utf8");
  return { path, created: true };
}

export interface InitDeepResult {
  created: string[];
  skipped: string[];
}

export function initDeep(workspaceRoot: string, options: DiscoverInitDeepOptions = {}): InitDeepResult {
  const dirs = discoverInitDeepDirs(workspaceRoot, options);
  const created: string[] = [];
  const skipped: string[] = [];
  for (const dir of dirs) {
    const rel = relative(workspaceRoot, dir);
    const isRoot = rel === "";
    const path = join(dir, INIT_DEEP_FILE_NAME);
    if (existsSync(path)) {
      skipped.push(path);
      continue;
    }
    let children: string[] = [];
    try {
      children = readdirSync(dir)
        .filter((e) => !e.startsWith("."))
        .sort()
        .slice(0, 20);
    } catch {
      children = [];
    }
    const content = renderAgentsTemplate({
      dirRel: rel || basename(workspaceRoot),
      dirName: isRoot ? basename(workspaceRoot) : basename(dir),
      isRoot,
      children,
    });
    try {
      writeFileSync(path, content, "utf8");
      created.push(path);
    } catch {
      skipped.push(path);
    }
  }
  return { created, skipped };
}
