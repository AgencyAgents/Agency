/**
 * Live cost bench: each task of this folder runs through `agency -p` with a real model, in a fresh copy and a fresh
 * AGENCY_HOME. It reports whether the check passes with the tests unchanged, the model calls, the tokens and the cost.
 * Usage: bun packages/eval/bench/bench.ts --model openrouter/<id> [--config layer.json] [--only a,b] [--runs n] [--out file]
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const arg = (flag: string): string | undefined => {
  const i = process.argv.indexOf(flag);
  return i === -1 ? undefined : process.argv[i + 1];
};
const model = arg("--model");
if (!model) throw new Error("--model <provider/model> is required");
const layer = arg("--config") ? readFileSync(arg("--config") as string, "utf8") : "{}";
const only = arg("--only")?.split(",");
const runs = Number(arg("--runs") ?? 1);
const here = import.meta.dir;
const entry = join(here, "..", "..", "cli", "src", "entrypoint.ts");
const tasks = readdirSync(here, { withFileTypes: true })
  .filter((d) => d.isDirectory() && (!only || only.includes(d.name)))
  .map((d) => d.name);

/** Hashes of the check files: a run that edits them does not count as solved. */
const testHashes = (ws: string): string =>
  readdirSync(join(ws, "test"))
    .sort()
    .map((f) =>
      createHash("sha256")
        .update(readFileSync(join(ws, "test", f)))
        .digest("hex"),
    )
    .join();

interface Row {
  task: string;
  run: number;
  solved: boolean;
  calls: number;
  input: number;
  cached: number;
  output: number;
  costUsd: number;
  seconds: number;
  note?: string;
}

const rows: Row[] = [];
for (const task of tasks) {
  const { prompt, check } = JSON.parse(readFileSync(join(here, task, "task.json"), "utf8")) as {
    prompt: string;
    check: string;
  };
  for (let run = 1; run <= runs; run++) {
    const dir = mkdtempSync(join(tmpdir(), `agency-bench-${task}-`));
    const ws = join(dir, "ws");
    cpSync(join(here, task), ws, { recursive: true, filter: (src) => !src.endsWith("task.json") });
    for (const git of [
      ["init", "-q"],
      ["add", "-A"],
      ["-c", "user.name=b", "-c", "user.email=b@b", "commit", "-qm", "start"],
    ])
      spawnSync("git", git, { cwd: ws });
    mkdirSync(join(dir, "home", "config"), { recursive: true });
    mkdirSync(join(dir, "agents"));
    writeFileSync(join(dir, "home", "config", "config.jsonc"), layer);
    const before = testHashes(ws);
    const started = Date.now();
    const out = spawnSync(
      "bun",
      [
        entry,
        "-p",
        `${prompt}\nThe tests run with \`${check}\`.`,
        "--model",
        model,
        "--permission-mode",
        "allow-all",
        "--format",
        "json",
      ],
      {
        cwd: ws,
        encoding: "utf8",
        timeout: 600_000,
        env: {
          ...process.env,
          AGENCY_HOME: join(dir, "home"),
          AGENCY_AGENTS_HOME: join(dir, "agents"),
          AGENCY_PARENT_PID: String(process.pid),
          AGENCY_OPENROUTER_API_KEY: process.env.AGENCY_OPENROUTER_API_KEY ?? process.env.OPENROUTER_API_KEY,
        },
      },
    );
    const seconds = Math.round((Date.now() - started) / 1000);
    let result: {
      num_turns?: number;
      usage?: { inputTokens?: number; cachedInputTokens?: number; outputTokens?: number; costUsd?: number };
      error?: { message: string };
    } = {};
    try {
      result = JSON.parse(out.stdout.slice(out.stdout.indexOf("{")));
    } catch {}
    const [bin, ...checkArgs] = check.split(" ");
    const passed = spawnSync(bin as string, checkArgs, { cwd: ws, encoding: "utf8" }).status === 0;
    const untouched = testHashes(ws) === before;
    rows.push({
      task,
      run,
      solved: passed && untouched,
      calls: result.num_turns ?? 0,
      input: result.usage?.inputTokens ?? 0,
      cached: result.usage?.cachedInputTokens ?? 0,
      output: result.usage?.outputTokens ?? 0,
      costUsd: result.usage?.costUsd ?? 0,
      seconds,
      ...(untouched ? {} : { note: "edited the tests" }),
      ...(result.error ? { note: result.error.message.slice(0, 80) } : {}),
    });
    console.log(JSON.stringify(rows.at(-1)));
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // The daemon of the run works in this folder until the bench exits; the temporary folder of the system keeps it.
    }
  }
}

const sum = (key: "calls" | "input" | "cached" | "output" | "costUsd") =>
  rows.reduce((n, r) => n + r[key], 0);
const summary = {
  model,
  config: JSON.parse(layer),
  solved: `${rows.filter((r) => r.solved).length}/${rows.length}`,
  calls: sum("calls"),
  input: sum("input"),
  cached: sum("cached"),
  output: sum("output"),
  costUsd: Number(sum("costUsd").toFixed(4)),
};
console.log(JSON.stringify(summary));
const outFile = arg("--out");
if (outFile) writeFileSync(outFile, `${JSON.stringify({ summary, rows }, null, 2)}\n`);
