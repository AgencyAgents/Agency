/**
 * Runs each test file in its own `bun test` process with a wall-clock
 * timeout and crash-only retries.
 *
 * Background: Bun 1.4.0 segfaults intermittently in its Windows TCP
 * teardown when a test file's socket churn collides with process exit
 * (heap-layout dependent; the same file passes most runs and crashes
 * some). A crashed or wedged file must not fail the whole shard, but
 * genuine assertion failures must fail fast — so only a runtime crash
 * ("Bun has crashed") or a wall-clock timeout is retried, up to
 * `--retries` extra attempts. Any other nonzero exit fails immediately.
 *
 * Usage: bun scripts/run-test-file.ts [--timeout-ms 60000] [--retries 2] <dir...>
 * Each dir contributes its *.test.ts files (sorted); every file gets a
 * fresh process so one leaked handle can't wedge the whole shard.
 */
import { spawn } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

function usageError(message: string): never {
  console.error(`usage: bun scripts/run-test-file.ts [--timeout-ms N] [--retries N] <dir...>\n${message}`);
  process.exit(2);
}

const argv = Bun.argv.slice(2);
let timeoutMs = 60_000;
let retries = 2;
const dirs: string[] = [];
for (let i = 0; i < argv.length; i++) {
  const arg = argv[i];
  if (arg === undefined) break;
  if (arg === "--timeout-ms") {
    const value = Number(argv[++i]);
    if (!Number.isFinite(value) || value <= 0) usageError("bad --timeout-ms");
    timeoutMs = value;
  } else if (arg === "--retries") {
    const value = Number(argv[++i]);
    if (!Number.isInteger(value) || value < 0) usageError("bad --retries");
    retries = value;
  } else if (arg.startsWith("--")) {
    usageError(`unknown flag ${arg}`);
  } else {
    dirs.push(arg);
  }
}
if (dirs.length === 0) usageError("need at least one directory");

const files = dirs.flatMap((dir) => {
  try {
    if (statSync(dir).isFile()) return dir.endsWith(".test.ts") ? [dir] : [];
  } catch {
    usageError(`not found: ${dir}`);
  }
  return readdirSync(dir)
    .filter((name) => name.endsWith(".test.ts"))
    .sort()
    .map((name) => join(dir, name));
});
if (files.length === 0) usageError("no *.test.ts files found");

const CRASH_MARKER = "Bun has crashed";

function runOnce(file: string): Promise<{ code: number; timedOut: boolean; crashed: boolean }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["test", file], { stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    let settled = false;
    const finish = (result: { code: number; timedOut: boolean; crashed: boolean }) => {
      if (settled) return;
      settled = true;
      clearTimeout(killer);
      resolve(result);
    };
    const killer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        // Already gone; finish() below still reports the timeout.
      }
      finish({ code: 124, timedOut: true, crashed: false });
    }, timeoutMs);
    if (killer.unref) killer.unref();
    child.stdout?.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
      process.stdout.write(chunk);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
      process.stderr.write(chunk);
    });
    child.on("error", () => finish({ code: 127, timedOut: false, crashed: false }));
    child.on("exit", (code) =>
      finish({ code: code ?? 1, timedOut: false, crashed: output.includes(CRASH_MARKER) }),
    );
  });
}

let failed = false;
for (const file of files) {
  let attempt = 0;
  for (;;) {
    attempt++;
    console.log(`[run-test-file] ${file} (attempt ${attempt}/${retries + 1})`);
    const result = await runOnce(file);
    if (result.code === 0) break;
    const retryable = result.timedOut || result.crashed;
    if (!retryable || attempt > retries) {
      console.error(
        `[run-test-file] FAIL ${file}: ` +
          (result.timedOut ? `no exit within ${timeoutMs}ms` : `exit code ${result.code}`),
      );
      failed = true;
      break;
    }
    console.log(`[run-test-file] retrying ${file} (${result.timedOut ? "timeout" : "runtime crash"})`);
  }
  if (failed) break;
}
process.exit(failed ? 1 : 0);
