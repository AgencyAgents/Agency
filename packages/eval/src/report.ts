import { formatCacheHitRate, formatCostUsd } from "@agency/telemetry";
import type { EvalReport } from "./types.ts";

/** Deterministic serialization: fixed key order, 2-space indent, one newline. */
export function serializeReport(report: EvalReport): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}

/** Human-readable per-roster table for console output. */
export function renderReport(report: EvalReport): string {
  const lines = [
    `eval baseline (prompt ${report.promptVersion})`,
    "roster tasks pass-rate cost/task total-usd tokens cached hit conflicts wall-ms",
  ];
  for (const s of report.scores) {
    lines.push(
      [
        s.roster,
        String(s.tasks),
        s.passRate.toFixed(4),
        s.costPerCompleted === null ? "n/a" : formatCostUsd(s.costPerCompleted),
        formatCostUsd(s.totalUsd),
        String(s.inputTokens + s.outputTokens),
        String(s.cachedInputTokens),
        formatCacheHitRate(s.cacheHitRate ?? undefined),
        String(s.conflicts),
        String(s.wallClockMs),
      ].join(" "),
    );
  }
  for (const p of report.pending) lines.push(`${p.roster} pending (maps to ${p.mapsTo}, owner ${p.owner})`);
  return `${lines.join("\n")}\n`;
}
