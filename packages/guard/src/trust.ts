import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, sep } from "node:path";
import { AgencyError, ErrorCode } from "@agency/schema";

export interface TrustStore {
  isTrusted(path: string): boolean;
  trust(path: string): void;
  distrust(path: string): void;
}

/**
 * Persists trust decisions as a flat JSON list on disk. A directory is
 * untrusted until explicitly confirmed: repo-provided instructions and
 * config must not load before that (R2/trust gate: AGENTS.md is an
 * injection surface), and — A5 — tools that mutate or execute refuse to run
 * in an untrusted workspace. Trust inherits downward: trusting a parent
 * directory covers every subdirectory, so trusting a workspace root once
 * covers the whole tree without per-directory prompts.
 */
export function createFileTrustStore(storePath: string): TrustStore {
  let cached: { mtimeMs: number; paths: string[] } | undefined;

  function read(): string[] {
    if (!existsSync(storePath)) {
      cached = undefined;
      return [];
    }
    try {
      const stat = statSync(storePath);
      if (cached && cached.mtimeMs === stat.mtimeMs) return cached.paths;
      const parsed = JSON.parse(readFileSync(storePath, "utf8"));
      const paths = Array.isArray(parsed) ? parsed : [];
      cached = { mtimeMs: stat.mtimeMs, paths };
      return paths;
    } catch {
      return cached?.paths ?? [];
    }
  }

  function write(paths: string[]): void {
    mkdirSync(dirname(storePath), { recursive: true });
    writeFileSync(storePath, JSON.stringify(paths, null, 2));
    try {
      cached = { mtimeMs: statSync(storePath).mtimeMs, paths };
    } catch {
      cached = undefined;
    }
  }

  return {
    isTrusted(path) {
      const normalized = normalizeDir(path);
      return read().some((trusted) => {
        const dir = normalizeDir(trusted);
        return dir === normalized || (dir === sep ? true : normalized.startsWith(`${dir}${sep}`));
      });
    },
    trust(path) {
      const normalized = normalizeDir(path);
      const paths = read();
      if (!paths.some((p) => normalizeDir(p) === normalized)) write([...paths, path]);
    },
    distrust(path) {
      const normalized = normalizeDir(path);
      write(read().filter((p) => normalizeDir(p) !== normalized));
    },
  };
}

/**
 * Canonical form for string comparison: backslashes to forward slashes,
 * trailing separators removed, and `.`/`..` segments resolved lexically (the
 * directories may not exist on disk, so realpath is not an option) — without
 * that, `/repo/project/../project-evil` would inherit `/repo/project`'s trust.
 */
function normalizeDir(path: string): string {
  const absolute = path.startsWith("/") || /^[A-Za-z]:/.test(path);
  const parts: string[] = [];
  for (const segment of path.replace(/\\/g, "/").split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (parts.length > 0) parts.pop();
      continue;
    }
    parts.push(segment);
  }
  const joined = parts.join(sep);
  if (absolute) return joined ? `${sep}${joined}` : sep;
  return joined;
}

/** Throws PERMISSION_DENIED if `path` (or an ancestor of it) hasn't been explicitly trusted. */
export function requireTrust(store: TrustStore, path: string): void {
  if (store.isTrusted(path)) return;
  throw new AgencyError(ErrorCode.PERMISSION_DENIED, `"${path}" is not a trusted directory`, {
    source: "trust",
    context: { path },
  });
}
