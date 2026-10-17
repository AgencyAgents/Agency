import { spawnSync } from "node:child_process";
import { extname } from "node:path";

const JS_LOADERS: Record<string, "js" | "jsx" | "ts" | "tsx"> = {
  ".js": "js",
  ".mjs": "js",
  ".cjs": "js",
  ".jsx": "jsx",
  ".ts": "ts",
  ".mts": "ts",
  ".cts": "ts",
  ".tsx": "tsx",
};

const PYTHON_CHECK =
  "import ast,sys\ntry: ast.parse(sys.stdin.read())\nexcept SyntaxError as e: print(f'{e.lineno}: {e.msg}')";

/**
 * The first syntax error of a file's text, or undefined when it parses or its language has no check here. A parse,
 * not a type check: it runs on each edit, and SWE-agent measured such a check on each edit at +3 points of SWE-bench.
 */
export function syntaxError(path: string, text: string): string | undefined {
  const ext = extname(path).toLowerCase();
  const loader = JS_LOADERS[ext];
  if (loader !== undefined) {
    try {
      new Bun.Transpiler({ loader }).transformSync(text);
      return undefined;
    } catch (error) {
      const message = (error instanceof Error ? error.message : String(error)).split("\n")[0];
      const line = (error as { position?: { line?: number } }).position?.line;
      return line === undefined ? message : `${line}: ${message}`;
    }
  }
  if (ext === ".json") {
    try {
      JSON.parse(text);
      return undefined;
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }
  if (ext === ".py") {
    // ponytail: no Python on PATH means no check, as for a language with no parser here.
    const out = spawnSync("python", ["-c", PYTHON_CHECK], { input: text, encoding: "utf8", timeout: 5000 });
    return out.status === 0 && out.stdout.trim() !== "" ? out.stdout.trim() : undefined;
  }
  return undefined;
}

/** A note for the model when an edit broke the parse of a file that parsed before it; a file broken before gets none. */
export function syntaxNote(path: string, before: string | undefined, after: string): string | undefined {
  const error = syntaxError(path, after);
  if (error === undefined) return undefined;
  if (before !== undefined && syntaxError(path, before) !== undefined) return undefined;
  return `This change leaves ${path} with a syntax error: ${error}. Fix it before you go on.`;
}
