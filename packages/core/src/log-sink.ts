import { appendFileSync, existsSync, mkdirSync, renameSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

export interface RotatingFileSinkOptions {
  /** Directory the log lives in; created on first write if missing. */
  dir: string;
  fileName?: string;
  /** Rotate when the active file would exceed this size. */
  maxBytes?: number;
  /** How many rotated files (`.1` .. `.N`) to keep; older ones are deleted. */
  maxFiles?: number;
}

export interface RotatingFileSink {
  write(line: string): void;
  /** Current active file path, for `agency debug` to know what to bundle. */
  path(): string;
}

/**
 * Size-capped JSONL sink: the active file rotates to `.1` (and `.1` to `.2`,
 * etc.) once it would grow past `maxBytes`, so logs persist to `logDir()`
 * without ever growing without bound. Appends are synchronous one-line writes,
 * the same crash discipline as SessionStore.
 */
export function createRotatingFileSink(options: RotatingFileSinkOptions): RotatingFileSink {
  const fileName = options.fileName ?? "agency.log";
  const maxBytes = options.maxBytes ?? 5 * 1024 * 1024;
  const maxFiles = options.maxFiles ?? 3;
  const activePath = join(options.dir, fileName);

  let initialized = false;
  let size = 0;

  function init(): void {
    if (initialized) return;
    mkdirSync(options.dir, { recursive: true });
    size = existsSync(activePath) ? statSync(activePath).size : 0;
    initialized = true;
  }

  function rotate(): void {
    for (let i = maxFiles - 1; i >= 1; i--) {
      const from = join(options.dir, `${fileName}.${i}`);
      if (!existsSync(from)) continue;
      const to = join(options.dir, `${fileName}.${i + 1}`);
      rmSync(to, { force: true });
      renameSync(from, to);
    }
    renameSync(activePath, join(options.dir, `${fileName}.1`));
    size = 0;
  }

  return {
    write(line) {
      init();
      if (size > 0 && size + line.length + 1 > maxBytes) rotate();
      appendFileSync(activePath, `${line}\n`);
      size += line.length + 1;
    },
    path() {
      init();
      return activePath;
    },
  };
}
