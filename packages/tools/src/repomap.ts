import { type Dirent, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { estimateTokens } from "@agency/providers";
import { loadGitignore } from "./gitignore.ts";

/** Default token budget for a rendered map (Todo 18 reuses this idiom). */
export const DEFAULT_REPOMAP_TOKEN_CAP = 1000;
/** Prefix of the truncation marker appended when files are omitted. */
export const REPOMAP_TRUNCATION_MARKER = "[repomap truncated:";

/** Walk bound: oversized repos degrade to a subset, never OOM. */
const MAX_FILES = 5000;
/** Per-file content bound: larger files list with empty symbols. */
const MAX_FILE_BYTES = 256 * 1024;
const MAX_SYMBOLS_PER_FILE = 100;
/** Refs scan is O(F^2); beyond this only name-match scores. */
const MAX_REF_FILES = 2000;
/** Hard ignores on top of .gitignore (mirrors the glob tool). */
const ALWAYS_IGNORED = new Set([".git", "node_modules"]);

export interface RepoMapEntry {
  /** Workspace-relative forward-slash path. */
  path: string;
  /** Declaration names from regex line scans, capped. */
  symbols: string[];
  mtimeMs: number;
  size: number;
  /** Other indexed files whose text mentions this file's key name. */
  refs: number;
  /** False when content was skipped (binary, huge, unreadable). */
  scanned: boolean;
}

export interface RepoMapIndex {
  root: string;
  files: RepoMapEntry[];
  /** True when the MAX_FILES walk bound cut the scan short. */
  capped: boolean;
}

export interface RankedRepoMapEntry extends RepoMapEntry {
  score: number;
}

export interface RenderedRepoMap {
  text: string;
  truncated: boolean;
  omitted: number;
  estimatedTokens: number;
}

const SYMBOL_PATTERNS = [
  /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/,
  /^\s*(?:export\s+)?(?:default\s+)?class\s+([A-Za-z_$][\w$]*)/,
  /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)/,
  /^\s*(?:export\s+)?(?:interface|type|enum)\s+([A-Za-z_$][\w$]*)/,
  /^\s*def\s+([A-Za-z_]\w*)/,
  /^\s*fn\s+([A-Za-z_]\w*)/,
  /^\s*func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/,
];

function extractSymbols(text: string): string[] {
  const names: string[] = [];
  const seen = new Set<string>();
  for (const line of text.split("\n")) {
    for (const pattern of SYMBOL_PATTERNS) {
      const match = pattern.exec(line);
      if (match?.[1] !== undefined && !seen.has(match[1])) {
        seen.add(match[1]);
        names.push(match[1]);
        if (names.length >= MAX_SYMBOLS_PER_FILE) return names;
      }
    }
  }
  return names;
}

/** Basename without extension, the key other files reference. */
function keyFor(relPath: string): string {
  const base = relPath.split("/").pop() ?? relPath;
  const dot = base.lastIndexOf(".");
  return (dot > 0 ? base.slice(0, dot) : base).toLowerCase();
}

interface WalkedFile {
  rel: string;
  mtimeMs: number;
  size: number;
}

/** Sorted ignore-aware rel paths; symlinks never followed, errors skipped. */
function walkRelPaths(root: string): { paths: WalkedFile[]; capped: boolean } {
  const isIgnored = loadGitignore(root);
  const paths: WalkedFile[] = [];
  let capped = false;
  const stack: string[] = [""];
  outer: while (stack.length > 0) {
    const dir = stack.pop() as string;
    let entries: Dirent[];
    try {
      entries = readdirSync(join(root, dir), { withFileTypes: true });
    } catch {
      continue;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const rel = dir.length > 0 ? `${dir}/${entry.name}` : entry.name;
      const top = rel.split("/")[0] as string;
      if (ALWAYS_IGNORED.has(top)) continue;
      if (rel === ".git" || rel.startsWith(".git/")) continue;
      if (isIgnored?.(rel)) continue;
      if (entry.isDirectory()) {
        stack.push(rel);
      } else if (entry.isFile()) {
        try {
          const st = statSync(join(root, rel));
          paths.push({ rel, mtimeMs: st.mtimeMs, size: st.size });
        } catch {
          // vanished or unreadable metadata, skip without failing the scan
        }
        if (paths.length >= MAX_FILES) {
          capped = true;
          break outer;
        }
      }
    }
  }
  paths.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  return { paths, capped };
}

/**
 * Builds the deterministic structural index. Pure library, no daemon or
 * prompt wiring (that decision is recorded in the close-gaps notepad).
 */
export function buildRepoMap(root: string): RepoMapIndex {
  const { paths, capped } = walkRelPaths(root);
  const texts = new Map<string, string>();
  const files: RepoMapEntry[] = paths.map((p) => {
    let symbols: string[] = [];
    let scanned = false;
    if (p.size <= MAX_FILE_BYTES) {
      try {
        const buf = readFileSync(join(root, p.rel));
        if (!buf.includes(0)) {
          const text = buf.toString("utf8");
          texts.set(p.rel, text.toLowerCase());
          symbols = extractSymbols(text);
          scanned = true;
        }
      } catch {
        // binary, denied, or vanished mid-scan: entry stays, content skipped
      }
    }
    return { path: p.rel, symbols, mtimeMs: p.mtimeMs, size: p.size, refs: 0, scanned };
  });
  if (files.length <= MAX_REF_FILES) {
    for (const file of files) {
      const key = keyFor(file.path);
      if (key.length < 3) continue;
      let count = 0;
      for (const [rel, text] of texts) {
        if (rel !== file.path && text.includes(key)) count += 1;
      }
      file.refs = count;
    }
  }
  return { root, files, capped };
}

/** Mtime-keyed freshness flag; callers recompute via buildRepoMap. */
export function isRepoMapFresh(index: RepoMapIndex): boolean {
  const { paths } = walkRelPaths(index.root);
  if (paths.length !== index.files.length) return false;
  const known = new Map(index.files.map((f) => [f.path, f]));
  for (const p of paths) {
    const entry = known.get(p.rel);
    if (!entry || entry.mtimeMs !== p.mtimeMs || entry.size !== p.size) return false;
  }
  return true;
}

function queryTerms(query: string): string[] {
  return query
    .toLowerCase()
    .split(/[^a-z0-9_$]+/)
    .filter((t) => t.length > 0);
}

/** Name-match (path/symbol) weighted over reference-count scoring. */
export function queryRepoMap(index: RepoMapIndex, query: string): RankedRepoMapEntry[] {
  const terms = queryTerms(query);
  const ranked = index.files.map((file) => {
    const key = keyFor(file.path);
    const pathLower = file.path.toLowerCase();
    const symbolsLower = file.symbols.map((s) => s.toLowerCase());
    let nameScore = 0;
    for (const term of terms) {
      if (key.includes(term)) nameScore += 3;
      if (pathLower.includes(term)) nameScore += 1;
      if (symbolsLower.some((s) => s.includes(term))) nameScore += 2;
    }
    return { ...file, score: nameScore * 10 + file.refs };
  });
  ranked.sort((a, b) => b.score - a.score || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return ranked;
}

function entryLine(file: RankedRepoMapEntry): string {
  return file.symbols.length > 0 ? `${file.path}: ${file.symbols.join(", ")}` : file.path;
}

/** Token-budgeted map; oversized output degrades to a subset plus marker. */
export function renderRepoMap(
  index: RepoMapIndex,
  query: string,
  options?: { maxTokens?: number },
): RenderedRepoMap {
  const cap = options?.maxTokens ?? DEFAULT_REPOMAP_TOKEN_CAP;
  const ranked = queryRepoMap(index, query).filter((f) => f.score > 0);
  const lines: string[] = [];
  let acc = "";
  for (const file of ranked) {
    const next = acc.length > 0 ? `${acc}\n${entryLine(file)}` : entryLine(file);
    if (estimateTokens(next) > cap) break;
    acc = next;
    lines.push(entryLine(file));
  }
  let omitted = ranked.length - lines.length;
  // Marker stays short so it fits caps that force a subset.
  const markerFor = (n: number): string => `... ${REPOMAP_TRUNCATION_MARKER} ${n} more]`;
  if (omitted > 0 || index.capped) {
    while (lines.length > 0 && estimateTokens(`${lines.join("\n")}\n${markerFor(omitted)}`) > cap) {
      lines.pop();
      omitted += 1;
    }
    const marker = markerFor(index.capped ? ranked.length - lines.length : omitted);
    acc = lines.length > 0 ? `${lines.join("\n")}\n${marker}` : marker;
    return {
      text: acc,
      truncated: true,
      omitted: ranked.length - lines.length,
      estimatedTokens: estimateTokens(acc),
    };
  }
  return { text: acc, truncated: false, omitted: 0, estimatedTokens: estimateTokens(acc) };
}
