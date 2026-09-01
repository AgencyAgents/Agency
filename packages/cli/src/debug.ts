import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Redactor } from "@agency/guard";
import { buildDebugBundle, formatDebugBundle } from "@agency/telemetry";

export interface DebugCommandOptions {
  workspaceRoot?: string;
  /** Where the bundle file lands; defaults to the current directory. */
  outDir?: string;
  version?: string;
  /** Injectable clock for the filename timestamp (tests). */
  now?: () => Date;
}

export interface DebugCommandResult {
  path: string;
  report: string;
}

/**
 * `agency debug`: assembles the redacted support bundle and writes it next to
 * the user, so attaching it to an issue is one file copy. Redaction happens
 * inside the bundle builder; nothing here ever sees a raw secret.
 */
export function debugCommand(options: DebugCommandOptions = {}): DebugCommandResult {
  const workspaceRoot = options.workspaceRoot ?? process.cwd();
  const bundle = buildDebugBundle({
    workspaceRoot,
    redactor: new Redactor(),
    version: options.version,
  });
  const report = formatDebugBundle(bundle);

  const stamp = (options.now ?? (() => new Date()))().toISOString().replace(/[:.]/g, "-");
  const outDir = options.outDir ?? process.cwd();
  mkdirSync(outDir, { recursive: true });
  const path = join(outDir, `agency-debug-${stamp}.md`);
  writeFileSync(path, `${report}\n`);
  return { path, report };
}
