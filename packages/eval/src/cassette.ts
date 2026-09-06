import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { EvalCassette } from "./types.ts";

/** Load one cassette, rejecting malformed or non-deterministic content. */
export function loadCassette(path: string): EvalCassette {
  const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
  return checkCassette(raw, path);
}

/** Load every cassette in a directory, sorted by filename for stability. */
export function loadCassettes(dir: string): EvalCassette[] {
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort();
  return files.map((f) => loadCassette(join(dir, f)));
}

/** Minimal shape check: guards the scorer against hand-edited drift. */
export function checkCassette(raw: unknown, path: string): EvalCassette {
  const c = raw as Partial<EvalCassette>;
  if (c === null || typeof c !== "object") throw new Error(`eval cassette invalid: ${path}`);
  if (c.version !== 1) throw new Error(`eval cassette version mismatch: ${path}`);
  if (
    c.roster !== "solo" &&
    c.roster !== "team" &&
    c.roster !== "reviewer-first" &&
    c.roster !== "fixed" &&
    c.roster !== "ladder"
  )
    throw new Error(`eval cassette roster invalid: ${path}`);
  if (typeof c.promptVersion !== "string" || c.promptVersion.length === 0)
    throw new Error(`eval cassette promptVersion missing: ${path}`);
  if (!Array.isArray(c.tasks)) throw new Error(`eval cassette tasks missing: ${path}`);
  for (const t of c.tasks) {
    if (typeof t?.taskId !== "string" || typeof t?.passed !== "boolean" || typeof t?.usage !== "object")
      throw new Error(`eval cassette task invalid: ${path}`);
    if (typeof t.usage?.inputTokens !== "number" || typeof t.usage?.outputTokens !== "number")
      throw new Error(`eval cassette usage invalid: ${path}`);
    if (typeof t.wallClockMs !== "number" || typeof t.conflicts !== "number")
      throw new Error(`eval cassette counters invalid: ${path}`);
  }
  return c as EvalCassette;
}
