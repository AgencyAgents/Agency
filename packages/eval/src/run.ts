import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadCassettes } from "./cassette.ts";
import { noFetchHttp, replayTask } from "./replay.ts";
import { renderReport, serializeReport } from "./report.ts";
import { scoreReport } from "./scoring.ts";

const here = dirname(fileURLToPath(import.meta.url));

/** Replay cassettes with zero provider calls, print scores, write baseline. */
export async function main(): Promise<void> {
  const cassettes = loadCassettes(join(here, "..", "cassettes"));
  const http = noFetchHttp();
  for (const cassette of cassettes) {
    for (const task of cassette.tasks) {
      const result = await replayTask(http, task);
      if (result.messages.length === 0) throw new Error(`empty replay: ${task.taskId}`);
    }
  }
  const report = scoreReport(cassettes);
  process.stdout.write(renderReport(report));
  const out = join(here, "..", "report", "baseline.json");
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, serializeReport(report));
}

if (import.meta.main) await main();
