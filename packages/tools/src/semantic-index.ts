import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildRepoMap, isRepoMapFresh } from "./repomap.ts";

/**
 * SPIKE, not production semantics. Vectors below are offline deterministic
 * hashed-token vectors (token hash buckets, no learned weights), so recall
 * only proves chunk/store/cosine/staleness mechanics over the Todo 17
 * corpus idiom. A real embedding provider swap is recorded in the notepad.
 */

/** Hash-vector width; collisions stay noise-level on small corpora. */
export const SEMANTIC_VECTOR_DIM = 256;
/** Per-chunk text bound; larger files split into more chunks, never one blob. */
export const MAX_CHUNK_CHARS = 2000;
/** Per-file chunk bound; oversized files degrade to a prefix, never OOM. */
export const MAX_CHUNKS_PER_FILE = 8;
/** Fixed recall floor the seeded tests assert against. */
export const DEFAULT_SEMANTIC_THRESHOLD = 0.2;

/** Tiny stopword cut so natural-language filler does not sway cosine. */
const STOPWORDS = new Set(
  "a,an,the,how,do,does,is,are,what,where,which,who,i,we,you,it,to,of,in,on,for,with,me,my,please,show,tell,give,find".split(
    ",",
  ),
);

function tokensOf(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9_$]+/)
    .filter((t) => t.length > 1 && !STOPWORDS.has(t));
}

/** FNV-1a 32-bit, the only hash this spike needs. */
function hashToken(token: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < token.length; i++) {
    hash ^= token.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** L2-normalized hashed-token vector; zero vector when no tokens survive. */
export function hashedTokenVector(text: string, dim: number = SEMANTIC_VECTOR_DIM): number[] {
  const vec = new Array<number>(dim).fill(0);
  for (const token of tokensOf(text)) {
    const bucket = hashToken(token) % dim;
    vec[bucket] = (vec[bucket] as number) + 1;
  }
  const norm = Math.sqrt(vec.reduce((acc, v) => acc + v * v, 0));
  if (norm === 0) return vec;
  return vec.map((v) => v / norm);
}

/** Cosine over normalized vectors; 0 when either side is empty. */
export function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    dot += (a[i] as number) * (b[i] as number);
    normA += (a[i] as number) * (a[i] as number);
    normB += (b[i] as number) * (b[i] as number);
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

export interface SemanticChunk {
  /** Workspace-relative forward-slash path. */
  path: string;
  /** First repomap symbol named inside the chunk, when any. */
  symbol?: string;
  text: string;
  /** Hashed-token vector, NOT a real embedding (see file header). */
  vector: number[];
}

export interface SemanticFileRecord {
  path: string;
  mtimeMs: number;
  size: number;
  scanned: boolean;
}

export interface SemanticIndex {
  root: string;
  files: SemanticFileRecord[];
  chunks: SemanticChunk[];
  dim: number;
}

export interface SemanticHit {
  path: string;
  /** Max chunk cosine for the file. */
  score: number;
}

export interface SemanticQueryResult {
  hits: SemanticHit[];
  /** True when the corpus moved under the index; rebuild instead of trusting hits. */
  stale: boolean;
}

/** First known symbol mentioned in the chunk, used as a cheap symbol anchor. */
function anchorSymbol(chunkText: string, symbols: readonly string[]): string | undefined {
  const lower = chunkText.toLowerCase();
  return symbols.find((s) => s.length > 0 && lower.includes(s.toLowerCase()));
}

function chunkText(text: string): string[] {
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > 0 && chunks.length < MAX_CHUNKS_PER_FILE) {
    if (rest.length <= MAX_CHUNK_CHARS) {
      chunks.push(rest);
      break;
    }
    let cut = rest.lastIndexOf("\n", MAX_CHUNK_CHARS);
    if (cut <= 0) cut = MAX_CHUNK_CHARS;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n+/, "");
  }
  return chunks.filter((c) => c.trim().length > 0);
}

/** Builds the spike index over the Todo 17 corpus (repomap walk + ignores). */
export function buildSemanticIndex(root: string): SemanticIndex {
  const repoMap = buildRepoMap(root);
  const files: SemanticFileRecord[] = repoMap.files.map((f) => ({
    path: f.path,
    mtimeMs: f.mtimeMs,
    size: f.size,
    scanned: f.scanned,
  }));
  const chunks: SemanticChunk[] = [];
  for (const entry of repoMap.files) {
    if (!entry.scanned) continue;
    let text: string;
    try {
      text = readFileSync(join(root, entry.path), "utf8");
    } catch {
      continue;
    }
    for (const piece of chunkText(text)) {
      const symbol = anchorSymbol(piece, entry.symbols);
      chunks.push({
        path: entry.path,
        ...(symbol !== undefined ? { symbol } : {}),
        text: piece,
        vector: hashedTokenVector(piece),
      });
    }
  }
  return { root, files, chunks, dim: SEMANTIC_VECTOR_DIM };
}

/** Mtime-keyed freshness flag; delegates to the repomap idiom, never recomputes. */
export function isSemanticIndexFresh(index: SemanticIndex): boolean {
  return isRepoMapFresh({
    root: index.root,
    files: index.files.map((f) => ({ ...f, symbols: [], refs: 0 })),
    capped: false,
  });
}

/** Cosine recall aggregated per file; empty queries return no hits. */
export function querySemanticIndex(
  index: SemanticIndex,
  query: string,
  options?: { topK?: number; threshold?: number },
): SemanticQueryResult {
  const stale = !isSemanticIndexFresh(index);
  const queryVec = hashedTokenVector(query, index.dim);
  if (queryVec.every((v) => v === 0)) return { hits: [], stale };
  const threshold = options?.threshold ?? DEFAULT_SEMANTIC_THRESHOLD;
  const best = new Map<string, number>();
  for (const chunk of index.chunks) {
    const score = cosineSimilarity(queryVec, chunk.vector);
    if (score >= threshold && score > (best.get(chunk.path) ?? 0)) best.set(chunk.path, score);
  }
  const hits = [...best.entries()]
    .map(([path, score]) => ({ path, score }))
    .sort((a, b) => b.score - a.score || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const topK = options?.topK ?? hits.length;
  return { hits: hits.slice(0, Math.max(0, topK)), stale };
}

interface ChunkLine {
  kind?: unknown;
  path?: unknown;
  symbol?: unknown;
  text?: unknown;
  vector?: unknown;
}

function isChunkLine(raw: unknown): raw is { path: string; text: string; vector: number[]; symbol?: string } {
  if (typeof raw !== "object" || raw === null) return false;
  const r = raw as Record<string, unknown>;
  return (
    typeof r.path === "string" &&
    typeof r.text === "string" &&
    Array.isArray(r.vector) &&
    r.vector.every((v) => typeof v === "number") &&
    (r.symbol === undefined || typeof r.symbol === "string")
  );
}

/** One JSONL line per chunk plus a header line; header carries root + mtimes. */
export function saveSemanticIndex(filePath: string, index: SemanticIndex): void {
  const lines = [
    JSON.stringify({ kind: "header", root: index.root, dim: index.dim, files: index.files }),
    ...index.chunks.map((c) => JSON.stringify({ kind: "chunk", ...c })),
  ];
  writeFileSync(filePath, lines.map((l) => `${l}\n`).join(""), "utf8");
}

/** Loads the chunk store; corrupt lines skip with a warning, never throw. */
export function loadSemanticIndex(
  filePath: string,
  opts?: { root?: string; onWarn?: (message: string) => void },
): SemanticIndex {
  const warn = opts?.onWarn ?? ((m: string) => console.warn(`[semantic-index] ${m}`));
  let text: string;
  try {
    text = readFileSync(filePath, "utf8");
  } catch {
    return { root: opts?.root ?? "", files: [], chunks: [], dim: SEMANTIC_VECTOR_DIM };
  }
  let root = opts?.root ?? "";
  let dim = SEMANTIC_VECTOR_DIM;
  let files: SemanticFileRecord[] = [];
  const chunks: SemanticChunk[] = [];
  for (const [offset, line] of text.split("\n").entries()) {
    if (line.length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line) as ChunkLine;
    } catch (error) {
      warn(
        `corrupt chunk line ${offset + 1} skipped: ${error instanceof Error ? error.message : String(error)}`,
      );
      continue;
    }
    if (typeof parsed === "object" && parsed !== null && (parsed as ChunkLine).kind === "header") {
      const h = parsed as { root?: unknown; dim?: unknown; files?: unknown };
      if (typeof h.root === "string") root = h.root;
      if (typeof h.dim === "number" && h.dim > 0) dim = Math.floor(h.dim);
      if (Array.isArray(h.files)) {
        files = (h.files as unknown[]).filter(
          (f): f is SemanticFileRecord =>
            typeof f === "object" &&
            f !== null &&
            typeof (f as SemanticFileRecord).path === "string" &&
            typeof (f as SemanticFileRecord).mtimeMs === "number",
        );
      }
      continue;
    }
    if (!isChunkLine(parsed)) {
      warn(`chunk line ${offset + 1} skipped (shape mismatch)`);
      continue;
    }
    chunks.push({
      path: parsed.path,
      ...(parsed.symbol !== undefined ? { symbol: parsed.symbol } : {}),
      text: parsed.text,
      vector: parsed.vector,
    });
  }
  return { root, files, chunks, dim };
}
