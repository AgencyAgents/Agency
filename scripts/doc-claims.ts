/**
 * Claim gate: every backticked doc symbol must resolve to a non-test source hit, and a symbol a
 * status row calls wired must be used outside the file that declares it. Nonzero exit lists misses.
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

const STATUS_DOC = "docs/status.md";
const COMMENT_RE = /\/\*[\s\S]*?\*\/|^\s*\/\/.*$/gm;
const DECL_RE =
  /^(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function\*?|class|abstract class|const|let|var)\s+([A-Za-z_$][\w$]*)/;
const TOP_LEVEL_RE =
  /^(?:export|function|async function|class|abstract|const|let|var|enum|type|interface|declare|import)\b/;
const WORD_RE = /[A-Za-z_$][\w$]*/g;

/** Rows of the status table whose Wired cell starts with Yes, with the symbols each row names. */
export function wiredClaims(statusMd: string): Array<{ item: string; symbols: string[] }> {
  const claims: Array<{ item: string; symbols: string[] }> = [];
  for (const line of statusMd.split(/\r?\n/)) {
    const [, item, , wired] = line.split("|").map((cell) => cell.trim());
    if (item === undefined || wired === undefined || !wired.startsWith("Yes")) continue;
    claims.push({ item, symbols: extractSymbols(`${item} ${wired}`) });
  }
  return claims;
}

/**
 * Splits sources into top-level declarations and walks name references from the root files and
 * from module-level code. A name match counts as a use, so `declared` minus `live` is a lower bound.
 */
export function reachability(
  sources: Map<string, string>,
  isRoot: (file: string) => boolean,
): { declared: Set<string>; live: Set<string> } {
  const bodies = new Map<string, string[]>();
  const queue: string[] = [];
  for (const [file, text] of sources) {
    let current: string | undefined;
    for (const line of text.replace(COMMENT_RE, "").split(/\r?\n/)) {
      if (TOP_LEVEL_RE.test(line)) current = DECL_RE.exec(line)?.[1];
      // Module-level statements run on import, so they seed the walk like a root does.
      if (current === undefined || isRoot(file)) queue.push(line);
      if (current !== undefined) bodies.set(current, [...(bodies.get(current) ?? []), line]);
    }
  }
  const live = new Set<string>();
  while (queue.length > 0) {
    for (const word of (queue.pop() as string).match(WORD_RE) ?? []) {
      if (live.has(word) || !bodies.has(word)) continue;
      live.add(word);
      queue.push(...(bodies.get(word) as string[]));
    }
  }
  return { declared: new Set(bodies.keys()), live };
}

/** Wired symbols that no root reaches. Names with no top-level declaration (RPC names, fields) are skipped. */
export function findUnwired(
  claims: Array<{ item: string; symbols: string[] }>,
  reach: { declared: Set<string>; live: Set<string> },
): Array<{ item: string; symbol: string }> {
  return claims.flatMap(({ item, symbols }) =>
    symbols
      .filter((symbol) => reach.declared.has(symbol) && !reach.live.has(symbol))
      .map((symbol) => ({ item, symbol })),
  );
}

/** The CLI entrypoint and the SDK are what a user can run or import. */
const isRootFile = (file: string): boolean => /[/]cli[/]src[/]entrypoint\.ts$|[/]sdk[/]src[/]/.test(file);

if (import.meta.main) {
  const root = join(import.meta.dir, "..");
  const docs = new Map<string, string[]>();
  for (const rel of CLAIM_DOCS) {
    let text: string;
    try {
      text = readFileSync(join(root, rel), "utf8");
    } catch {
      // *.local.md docs are gitignored local-only; absent means skip, not fail.
      if (rel.endsWith(".local.md")) {
        console.error(`warning: skipping missing local doc: ${rel}`);
        continue;
      }
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
  const sources = new Map(srcFiles.map((file) => [file, readFileSync(file, "utf8")]));
  const unwired = findUnwired(
    wiredClaims(readFileSync(join(root, STATUS_DOC), "utf8")),
    reachability(sources, isRootFile),
  );
  if (unwired.length > 0) {
    for (const miss of unwired)
      console.log(`${miss.symbol} (called wired, no production caller; row: ${miss.item})`);
    console.log(`${unwired.length} unwired symbol(s) in ${STATUS_DOC}`);
    process.exit(1);
  }
  console.log(
    `doc-claims: ${srcFiles.length} source files, all backticked symbols resolve, wired rows have callers`,
  );
}
