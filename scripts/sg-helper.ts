/**
 * sg structural-search helper (ast-grep) — tree-sitter structural matching,
 * NOT string search.
 *
 * `rg`/`grep` match characters (regex over lines). `sg` matches syntax nodes:
 * a `--pattern` describes code shape with metavariables (`$VAR`, `$$$ARGS`),
 * so `catch ($E) {}` finds catch clauses by structure regardless of
 * variable names, whitespace, or comments — and `--rewrite` rewrites the
 * matched node. See docs/ast-grep.md for the sg-vs-rg distinction.
 *
 * Usage:
 *   bun scripts/sg-helper.ts --pattern 'catch ($E) {}' --lang ts [path]
 *   bun scripts/sg-helper.ts --pattern 'catch ($E) {}' --lang ts --rewrite 'catch ($E) { console.error($E); }' [path]
 *   bun scripts/sg-helper.ts --empty-catch --lang ts [path]
 *   bun scripts/sg-helper.ts --langs
 *
 * Exit codes: 0 matches (or --rewrite applied), 1 no matches, 2 usage/binary error.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/** Languages ast-grep parses (tree-sitter grammars). Keep at 25. */
export const SG_LANGS = [
  "bash",
  "c",
  "cpp",
  "csharp",
  "css",
  "dart",
  "elixir",
  "go",
  "haskell",
  "html",
  "java",
  "javascript",
  "json",
  "kotlin",
  "lua",
  "php",
  "python",
  "ruby",
  "rust",
  "scala",
  "solidity",
  "swift",
  "tsx",
  "typescript",
  "yaml",
] as const;

export type SgLang = (typeof SG_LANGS)[number];

/** Structural pattern that matches an empty catch block in JS/TS-family code.
 *  `$E` is a metavariable (any binding name — renaming-proof, unlike rg text);
 *  the empty `{}` matches only bodies with no statements, so non-empty
 *  handlers (logging, rethrow) do not match. */
export const EMPTY_CATCH_PATTERN = "catch ($E) {}";

/** Pattern variants keyed by language family for the empty-catch demo. */
export const EMPTY_CATCH_PATTERNS: Record<string, string> = {
  // C-like: try { ... } catch (e) {} — empty braces match only empty bodies
  c_like: "catch ($E) {}",
  // Python: except ...: pass — matched structurally, not as text
  python: "except $E: pass",
  // Rust: Err(_) => {} arm shape
  rust: "Err($E) => {}",
  // Go: if err != nil {} empty handler shape
  go: "if $E != nil { $$$ }",
  // Ruby: rescue => e (empty body)
  ruby: "rescue $E",
};

/** Candidate binary names, in preference order. `sg` is the ast-grep alias. */
export const SG_BINARIES = ["sg", "ast-grep"] as const;

export interface SgRunOptions {
  pattern: string;
  lang: string;
  path?: string;
  rewrite?: string;
  json?: boolean;
}

/** Build the argv for a structural search. Distinct from rg: `--pattern`, `--lang`, never a line regex. */
export function buildSgArgs(options: SgRunOptions): string[] {
  const args = ["scan", "--pattern", options.pattern, "--lang", options.lang];
  if (options.rewrite !== undefined) args.push("--rewrite", options.rewrite);
  if (options.json !== false) args.push("--json");
  args.push(options.path ?? ".");
  return args;
}

/** Normalize a user lang alias to an ast-grep lang id. */
export function normalizeLang(lang: string): string {
  const lower = lang.trim().toLowerCase();
  const aliases: Record<string, string> = {
    ts: "typescript",
    js: "javascript",
    py: "python",
    rs: "rust",
    rb: "ruby",
    sh: "bash",
    cs: "csharp",
    "c++": "cpp",
  };
  const resolved = aliases[lower] ?? lower;
  return (SG_LANGS as readonly string[]).includes(resolved) ? resolved : resolved;
}

function trySpawnSync(binary: string, args: string[]): { exitCode: number } | undefined {
  try {
    const result = Bun.spawnSync([binary, ...args], { stdout: "ignore", stderr: "ignore" });
    return { exitCode: result.exitCode };
  } catch {
    return undefined;
  }
}

/** True when an `sg`/`ast-grep` binary answers on PATH. */
export function sgAvailable(): string | undefined {
  for (const binary of SG_BINARIES) {
    const probed = trySpawnSync(binary, ["--version"]);
    if (probed && probed.exitCode === 0) return binary;
  }
  return undefined;
}

export interface SgMatch {
  file: string;
  line: number;
  text: string;
}

const TS_EMPTY_CATCH_RE = /catch\s*(?:\([^)]*\))?\s*\{\s*\}/g;

/** Fallback empty-catch finder used when no sg binary is installed.
 *  Approximates the structural `catch ($E) {}` query (empty braces after
 *  a catch header) so the demo/verification still runs; the real sg query is
 *  exact because it parses the tree. Clearly labeled in output as fallback. */
export function fallbackEmptyCatch(
  root: string,
  extensions = [".ts", ".tsx", ".js", ".jsx", ".mts", ".cts"],
): SgMatch[] {
  const out: SgMatch[] = [];
  const walk = (dir: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry === "node_modules" || entry === ".git" || entry === "dist") continue;
      const full = join(dir, entry);
      let st: ReturnType<typeof statSync>;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) walk(full);
      else if (extensions.some((e) => full.endsWith(e))) {
        let text: string;
        try {
          text = readFileSync(full, "utf8");
        } catch {
          continue;
        }
        const lines = text.split("\n");
        const flat = lines.join("\n");
        let m: RegExpExecArray | null;
        TS_EMPTY_CATCH_RE.lastIndex = 0;
        for (m = TS_EMPTY_CATCH_RE.exec(flat); m !== null; m = TS_EMPTY_CATCH_RE.exec(flat)) {
          const line = flat.slice(0, m.index).split("\n").length;
          const matchLine = lines[line - 1]?.trim() ?? m[0];
          out.push({ file: full, line, text: matchLine });
          if (m[0].length === 0) TS_EMPTY_CATCH_RE.lastIndex += 1;
        }
      }
    }
  };
  let st: ReturnType<typeof statSync>;
  try {
    st = statSync(root);
  } catch {
    return [];
  }
  if (st.isFile()) {
    const text = readFileSync(root, "utf8");
    const lines = text.split("\n");
    const flat = lines.join("\n");
    let m: RegExpExecArray | null;
    TS_EMPTY_CATCH_RE.lastIndex = 0;
    for (m = TS_EMPTY_CATCH_RE.exec(flat); m !== null; m = TS_EMPTY_CATCH_RE.exec(flat)) {
      const line = flat.slice(0, m.index).split("\n").length;
      out.push({ file: root, line, text: lines[line - 1]?.trim() ?? m[0] });
      if (m[0].length === 0) TS_EMPTY_CATCH_RE.lastIndex += 1;
    }
    return out;
  }
  walk(root);
  return out;
}

/** Calls that must never fail silently: session, dispatch, and trace writes. */
export const PERSISTENCE_MARKERS = [
  "todoStore.",
  "dispatchLog.",
  "writeCassette",
  "TraceRecorder",
  "SessionStore",
];

export interface SilentPersistenceCatch {
  file: string;
  line: number;
  kind: "empty-catch" | "silent-reject";
  text: string;
}

const SILENT_REJECT_RE = /\.catch\(\(\) => \{\s*\}\)/;
const COMMENT_ONLY_RE = /^\s*(\/\*.*\*\/|\/\/.*)?\s*$/;
const CATCH_OPEN_RE = /^\s*\}\s*catch\s*(\([^)]*\))?\s*\{\s*$/;
const PERSIST_CALL_RE = /\.(append|save|create)\(|writeCassette\(|new TraceRecorder\(/;

/** Line of the try that opens the block closed at catchLine, or -1. */
function enclosingTry(lines: string[], catchLine: number): number {
  let depth = 1;
  for (let k = catchLine - 1; k >= Math.max(0, catchLine - 60); k--) {
    const line = lines[k] ?? "";
    depth += (line.match(/\}/g) ?? []).length - (line.match(/\{/g) ?? []).length;
    if (depth === 0 && /\btry\b/.test(line)) return k;
    if (depth < 0) return -1;
  }
  return -1;
}

/** Heuristic gate: an empty catch or arg-less .catch on a persistence call. */
export function findSilentPersistenceCatches(
  root: string,
  extensions = [".ts", ".tsx", ".js", ".jsx", ".mts", ".cts"],
): SilentPersistenceCatch[] {
  const out: SilentPersistenceCatch[] = [];
  const files: string[] = [];
  const walk = (dir: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry === "node_modules" || entry === ".git" || entry === "dist") continue;
      const full = join(dir, entry);
      let st: ReturnType<typeof statSync>;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) walk(full);
      else if (extensions.some((e) => full.endsWith(e))) files.push(full);
    }
  };
  try {
    if (statSync(root).isFile()) files.push(root);
    else walk(root);
  } catch {
    return [];
  }
  for (const file of files) {
    let lines: string[];
    try {
      lines = readFileSync(file, "utf8").split("\n");
    } catch {
      continue;
    }
    const nearMarker = (from: number, to: number): boolean => {
      let sawMarker = false;
      let sawCall = false;
      for (let j = Math.max(0, from); j <= Math.min(lines.length - 1, to); j++) {
        const text = lines[j] ?? "";
        if (PERSISTENCE_MARKERS.some((m) => text.includes(m))) sawMarker = true;
        if (PERSIST_CALL_RE.test(text)) sawCall = true;
      }
      return sawMarker && sawCall;
    };
    const blockHasPersistCall = (from: number, to: number): boolean => {
      for (let j = Math.max(0, from); j <= Math.min(lines.length - 1, to); j++) {
        if (PERSIST_CALL_RE.test(lines[j] ?? "")) return true;
      }
      return false;
    };
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? "";
      TS_EMPTY_CATCH_RE.lastIndex = 0;
      if (TS_EMPTY_CATCH_RE.test(line)) {
        const from = enclosingTry(lines, i);
        if (from >= 0 && nearMarker(from, i)) {
          out.push({ file, line: i + 1, kind: "empty-catch", text: line.trim() });
        }
        continue;
      }
      if (CATCH_OPEN_RE.test(line)) {
        let j = i + 1;
        while (j < lines.length && (lines[j] ?? "").trim() === "") j++;
        if ((lines[j] ?? "").trim() === "}") {
          const from = enclosingTry(lines, i);
          if (from >= 0 && nearMarker(from, i)) {
            out.push({ file, line: i + 1, kind: "empty-catch", text: line.trim() });
          }
        }
        continue;
      }
      if (SILENT_REJECT_RE.test(line)) {
        if (nearMarker(i - 6, i) && blockHasPersistCall(i - 6, i)) {
          out.push({ file, line: i + 1, kind: "silent-reject", text: line.trim() });
        }
        continue;
      }
      if (/\.catch\(\(\w*\)? => \{$/.test(line.trim())) {
        let j = i + 1;
        while (j < lines.length && COMMENT_ONLY_RE.test(lines[j] ?? "")) j++;
        if ((lines[j] ?? "").trim() === "});" && nearMarker(i - 6, j) && blockHasPersistCall(i - 6, j)) {
          out.push({ file, line: i + 1, kind: "silent-reject", text: line.trim() });
        }
      }
    }
  }
  return out;
}

function printUsage(): void {
  console.log(
    [
      "sg-helper: structural search via ast-grep (sg), not string search.",
      "",
      "  bun scripts/sg-helper.ts --pattern '<pattern>' --lang <lang> [path]",
      "  bun scripts/sg-helper.ts --pattern '<p>' --lang <lang> --rewrite '<r>' [path]",
      "  bun scripts/sg-helper.ts --empty-catch --lang ts [path]",
      "  bun scripts/sg-helper.ts --enforce-persistence [path]",
      "  bun scripts/sg-helper.ts --langs",
      "",
      `Pattern uses AST metavariables ($VAR, $$$ARGS). Empty catch (ts): ${EMPTY_CATCH_PATTERN}`,
    ].join("\n"),
  );
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  if (argv.includes("--help") || argv.includes("-h")) {
    printUsage();
    process.exit(0);
  }
  if (argv.includes("--langs")) {
    console.log([...SG_LANGS].join("\n"));
    process.exit(0);
  }
  if (argv.includes("--enforce-persistence")) {
    const target = argv.filter((a) => !a.startsWith("--"))[0] ?? "packages/cli/src";
    const hits = findSilentPersistenceCatches(target);
    for (const h of hits) console.log(`${h.file}:${h.line} [${h.kind}] ${h.text}`);
    console.log(`# ${hits.length} silent persistence catch(es)`);
    process.exit(hits.length > 0 ? 2 : 0);
  }
  const flag = (name: string): string | undefined => {
    const i = argv.indexOf(name);
    return i !== -1 ? argv[i + 1] : undefined;
  };
  const emptyCatch = argv.includes("--empty-catch");
  const pattern = emptyCatch ? EMPTY_CATCH_PATTERN : flag("--pattern");
  const lang = normalizeLang(flag("--lang") ?? flag("--language") ?? (emptyCatch ? "typescript" : ""));
  const rewrite = flag("--rewrite");
  const positional = argv.filter(
    (a) => !a.startsWith("--") && !Object.values({ pattern, lang, rewrite }).includes(a),
  );
  // Re-derive positional: drop flag values robustly
  const consumed = new Set<string>();
  for (const name of ["--pattern", "--lang", "--language", "--rewrite"]) {
    const i = argv.indexOf(name);
    if (i !== -1 && argv[i + 1] !== undefined) consumed.add(argv[i + 1] as string);
  }
  void positional;
  const positionals = argv.filter((a, i) => {
    if (a.startsWith("--")) return false;
    if (consumed.has(a)) {
      consumed.delete(a);
      return false;
    }
    void i;
    return true;
  });
  const target = positionals[0] ?? ".";
  if (!pattern || !lang) {
    console.error("error: --pattern and --lang are required (or use --empty-catch --lang ts)");
    printUsage();
    process.exit(2);
  }
  const binary = sgAvailable();
  if (!binary) {
    console.log("# note: no sg/ast-grep binary on PATH — structural-fallback approximation of the pattern");
    console.log(`# structural query would be: sg scan --pattern '${pattern}' --lang ${lang} ${target}`);
    if (emptyCatch || pattern === EMPTY_CATCH_PATTERN) {
      const matches = fallbackEmptyCatch(target);
      for (const m of matches) console.log(`${m.file}:${m.line}:${m.text}`);
      console.log(`# ${matches.length} empty catch block(s) [fallback]`);
      process.exit(matches.length > 0 ? 0 : 1);
    }
    console.error(
      "error: sg/ast-grep is not installed; install via `cargo install ast-grep` (binary: sg). Only the --empty-catch fallback runs without it.",
    );
    process.exit(2);
  }
  const args = buildSgArgs({ pattern, lang, path: target, rewrite });
  const proc = Bun.spawn([binary, ...args], { stdout: "pipe", stderr: "pipe" });
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  await proc.exited;
  if (stdout.trim()) console.log(stdout.trimEnd());
  if (proc.exitCode !== 0 && proc.exitCode !== 1) {
    if (stderr.trim()) console.error(stderr.trimEnd());
    process.exit(proc.exitCode);
  }
  process.exit(proc.exitCode);
}
