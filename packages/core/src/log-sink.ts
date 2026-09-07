import { appendFile, mkdir, rename, rm, stat } from "node:fs/promises";
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
  /** Resolves when every line handed to write() so far has been flushed;
   *  graceful shutdowns await this so the last log lines aren't lost. */
  flush(): Promise<void>;
}

/**
 * Size-capped JSONL sink: the active file rotates to `.1` (and `.1` to `.2`,
 * etc.) once it would grow past `maxBytes`, so logs persist to `logDir()`
 * without ever growing without bound.
 *
 * Writes are asynchronous but strictly ordered (A3: appendFileSync for every
 * log line stalled the daemon's event loop). write() chains onto an internal
 * promise queue, so `write(a); write(b)` flushes a then b; the trade is that
 * lines still in the queue are lost on a hard crash — acceptable for logs,
 * and unlike SessionStore these lines carry no durability contract.
 */
export function createRotatingFileSink(options: RotatingFileSinkOptions): RotatingFileSink {
  const fileName = options.fileName ?? "agency.log";
  const maxBytes = options.maxBytes ?? 5 * 1024 * 1024;
  const maxFiles = options.maxFiles ?? 3;
  const activePath = join(options.dir, fileName);

  let initialized: Promise<void> | undefined;
  let size = 0;
  let queue: Promise<void> = Promise.resolve();

  function initOnce(): Promise<void> {
    initialized ??= (async () => {
      await mkdir(options.dir, { recursive: true });
      try {
        size = (await stat(activePath)).size;
      } catch {
        size = 0;
      }
    })();
    return initialized;
  }

  async function rotate(): Promise<void> {
    for (let i = maxFiles - 1; i >= 1; i--) {
      const from = join(options.dir, `${fileName}.${i}`);
      const to = join(options.dir, `${fileName}.${i + 1}`);
      try {
        await rm(to, { force: true });
        await rename(from, to);
      } catch {
        // Missing .i file: nothing to shift for this slot.
      }
    }
    await rename(activePath, join(options.dir, `${fileName}.1`));
    size = 0;
  }

  return {
    write(line) {
      queue = queue
        .catch(() => {
          // A failed log line must never stall or crash the caller; the
          // chain keeps moving so one bad append can't wedge the sink.
        })
        .then(async () => {
          await initOnce();
          if (size > 0 && size + line.length + 1 > maxBytes) await rotate();
          await appendFile(activePath, `${line}\n`);
          size += line.length + 1;
        });
    },
    path() {
      void initOnce();
      return activePath;
    },
    flush() {
      return queue;
    },
  };
}
