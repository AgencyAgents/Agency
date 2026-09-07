/**
 * Claim gate: every backticked doc symbol must resolve to a non-test source hit.
 * Fenced blocks are skipped and path-like spans ignored; nonzero exit lists misses.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/** Audited docs; comparison.local.md joins only while the file exists. */
export const CLAIM_DOCS = [
  "CHANGELOG.md",
  "features.local.md",
  "docs/teams.local.md",
  "docs/why-agency.local.md",
  "docs/comparison.local.md",
  "docs/status.md",
  "docs/orchestration.md",
  "docs/governance.md",
];

const BACKTICK_RE = /`([^`\n]+)`/g;
const FENCE_RE = /```[\s\S]*?(?:```|$)/g;
const SYMBOL_RE = /^[A-Za-z_$][\w$]*(?:[.#][A-Za-z_$][\w$]*)*$/;
/** File refs are not symbol claims; the last dotted segment gives them away. */
const FILE_EXT_RE = /\.(ts|tsx|mts|cts|js|jsx|sh|ps1|md|mdx|yml|yaml|json|toml)$/i;
const SKIP_DIRS = new Set(["node_modules", ".git", "dist"]);

/** Strip fenced code blocks so example snippets never count as claims. */
export function stripFences(text: string): string {
  return text.replace(FENCE_RE, "");
}

/** Backticked spans that read as symbols; paths, phrases, and keys are skipped. */
export function extractSymbols(text: string): string[] {
  const out: string[] = [];
  const clean = stripFences(text);
  BACKTICK_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  for (m = BACKTICK_RE.exec(clean); m !== null; m = BACKTICK_RE.exec(clean)) {
    const span = (m[1] ?? "").trim().replace(/\(\)$/, "");
    if (span !== "" && !FILE_EXT_RE.test(span) && SYMBOL_RE.test(span)) out.push(span);
  }
  return [...new Set(out)];
}

/** Source files under root, minus tests and build output. */
export function collectSourceFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (SKIP_DIRS.has(entry) || entry.endsWith(".test.ts")) continue;
      const full = join(dir, entry);
      let st: ReturnType<typeof statSync>;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) walk(full);
      else if (entry.endsWith(".ts")) out.push(full);
    }
  };
  walk(root);
  return out;
}

function readCorpus(files: string[]): string {
  const parts: string[] = [];
  for (const file of files) {
    try {
      parts.push(readFileSync(file, "utf8"));
    } catch {
      // Unreadable files contribute nothing to the corpus.
    }
  }
  return parts.join("\n");
}

function escapeRegExp(token: string): string {
  return token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** True when every dotted segment of the symbol hits the corpus on word bounds. */
export function symbolResolves(symbol: string, corpus: string): boolean {
  for (const token of symbol.split(/[.#]/)) {
    if (!new RegExp(`\\b${escapeRegExp(token)}\\b`).test(corpus)) return false;
  }
  return true;
}

export interface ClaimGap {
  symbol: string;
  docs: string[];
}

export function findUnresolved(docs: Map<string, string[]>, corpus: string): ClaimGap[] {
  const bySymbol = new Map<string, Set<string>>();
  for (const [doc, symbols] of docs) {
    for (const symbol of symbols) {
      const set = bySymbol.get(symbol) ?? new Set<string>();
      set.add(doc);
      bySymbol.set(symbol, set);
    }
  }
  const gaps: ClaimGap[] = [];
  for (const [symbol, docSet] of bySymbol) {
    if (!symbolResolves(symbol, corpus)) gaps.push({ symbol, docs: [...docSet].sort() });
  }
  gaps.sort((a, b) => (a.symbol < b.symbol ? -1 : 1));
  return gaps;
}

if (import.meta.main) {
  const root = join(import.meta.dir, "..");
  const docs = new Map<string, string[]>();
  for (const rel of CLAIM_DOCS) {
    let text: string;
    try {
      text = readFileSync(join(root, rel), "utf8");
    } catch {
      if (rel === "docs/comparison.local.md") continue;
      console.error(`error: required doc missing: ${rel}`);
      process.exit(2);
    }
    docs.set(rel, extractSymbols(text as string));
  }
  const packagesDir = join(root, "packages");
  let pkgEntries: string[];
  try {
    pkgEntries = readdirSync(packagesDir);
  } catch {
    console.error("error: packages/ not found");
    process.exit(2);
  }
  const srcFiles: string[] = [];
  for (const entry of pkgEntries) {
    srcFiles.push(...collectSourceFiles(join(packagesDir, entry, "src")));
  }
  const gaps = findUnresolved(docs, readCorpus(srcFiles));
  if (gaps.length > 0) {
    for (const gap of gaps) console.log(`${gap.symbol} (no non-test src hit; docs: ${gap.docs.join(", ")})`);
    console.log(`${gaps.length} unresolved doc symbol(s)`);
    process.exit(1);
  }
  console.log(`doc-claims: ${srcFiles.length} source files, all backticked symbols resolve`);
}
