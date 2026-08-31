export interface FormatterConfig {
  /** e.g. ["biome", "format", "--write"] or ["prettier", "--write"]; the
   *  file path is appended as the final argument. Unset means no formatter. */
  command?: string[];
}

/**
 * Runs the project's configured formatter after a successful edit, closing
 * the loop on a model writing correct-but-unformatted code. A missing or
 * failing formatter is non-fatal: the edit already succeeded, formatting is
 * a courtesy on top of it, not a reason to report the edit as failed.
 */
export async function runFormatter(config: FormatterConfig, filePath: string): Promise<void> {
  if (!config.command || config.command.length === 0) return;

  try {
    const proc = Bun.spawn([...config.command, filePath], { stdout: "ignore", stderr: "ignore" });
    await proc.exited;
  } catch {
    // Best-effort; the edit itself already succeeded.
  }
}
