import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  cacheDir,
  configDir,
  dataDir,
  logDir,
  pruneCache,
  pruneSessions,
  type RetentionPolicy,
  reportStorage,
} from "@agency/core";

/** `agency where`: every path Agency reads or writes, in one place. */
export function wherePaths(env: NodeJS.ProcessEnv = process.env): {
  config: string;
  data: string;
  cache: string;
  logs: string;
} {
  return {
    config: configDir(env),
    data: dataDir(env),
    cache: cacheDir(env),
    logs: logDir(env),
  };
}

export function whereCommand(env: NodeJS.ProcessEnv = process.env): string {
  const paths = wherePaths(env);
  const lines = [
    `config:  ${paths.config}`,
    `data:    ${paths.data}`,
    `cache:   ${paths.cache}`,
    `logs:    ${paths.logs}`,
  ];
  return lines.join("\n");
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(1)} ${units[unit]}`;
}

export type UsageGroup = "day" | "month" | "model";

export interface UsageRow {
  key: string;
  calls: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  cost: number;
}

/**
 * `agency usage`: the tokens and cost of every model call of every workspace, from the traces of the sessions,
 * as ccusage reports them for Claude Code. A day is a day of local time.
 */
export function usageReport(
  env: NodeJS.ProcessEnv,
  by: UsageGroup,
  since?: string,
): { rows: UsageRow[]; total: UsageRow } {
  const root = join(dataDir(env), "sessions");
  const rows = new Map<string, UsageRow>();
  const total: UsageRow = {
    key: "total",
    calls: 0,
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    cost: 0,
  };
  const files = existsSync(root)
    ? readdirSync(root, { recursive: true, encoding: "utf8" }).filter((file) => file.endsWith(".trace.jsonl"))
    : [];
  // ponytail: reads each trace whole; stream the files if traces grow to hundreds of MB.
  for (const file of files) {
    for (const line of readFileSync(join(root, file), "utf8").split("\n")) {
      if (!line.includes('"kind":"model"')) continue;
      let span: { kind?: string; startTime?: string; attributes?: Record<string, unknown> };
      try {
        span = JSON.parse(line);
      } catch {
        continue;
      }
      if (span.kind !== "model" || typeof span.startTime !== "string") continue;
      const day = new Date(span.startTime).toLocaleDateString("sv");
      if (since !== undefined && day < since) continue;
      const a = span.attributes ?? {};
      const num = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : 0);
      const key =
        by === "day"
          ? day
          : by === "month"
            ? day.slice(0, 7)
            : `${String(a.provider ?? "?")}/${String(a.model ?? "?")}`;
      const row = rows.get(key) ?? {
        key,
        calls: 0,
        inputTokens: 0,
        cachedInputTokens: 0,
        outputTokens: 0,
        cost: 0,
      };
      for (const target of [row, total]) {
        target.calls += 1;
        target.inputTokens += num(a.inputTokens);
        target.cachedInputTokens += num(a.cachedInputTokens);
        target.outputTokens += num(a.outputTokens);
        target.cost += num(a.cost);
      }
      rows.set(key, row);
    }
  }
  const sorted = [...rows.values()].sort((x, y) =>
    by === "model" ? y.cost - x.cost : x.key.localeCompare(y.key),
  );
  return { rows: sorted, total };
}

export function usageCommand(report: { rows: UsageRow[]; total: UsageRow }, by: UsageGroup): string {
  const n = (value: number) => value.toLocaleString("en-US");
  const cells = [
    [by, "calls", "input", "cached", "output", "cost"],
    ...[...report.rows, report.total].map((row) => [
      row.key,
      n(row.calls),
      n(row.inputTokens),
      n(row.cachedInputTokens),
      n(row.outputTokens),
      `$${row.cost.toFixed(4)}`,
    ]),
  ];
  const widths = cells[0]?.map((_, i) => Math.max(...cells.map((row) => (row[i] ?? "").length))) ?? [];
  return cells
    .map((row) =>
      row
        .map((cell, i) => (i === 0 ? cell.padEnd(widths[i] ?? 0) : cell.padStart(widths[i] ?? 0)))
        .join("  "),
    )
    .join("\n");
}

/** `agency storage`: size accounting by category. */
export async function storageCommand(env: NodeJS.ProcessEnv = process.env): Promise<string> {
  const report = await reportStorage(env);
  return [
    `data:   ${formatBytes(report.dataBytes)}  (${report.dataDir})`,
    `cache:  ${formatBytes(report.cacheBytes)}  (${report.cacheDir}, safe to delete)`,
    `logs:   ${formatBytes(report.logsBytes)}  (${report.logsDir})`,
  ].join("\n");
}

/** `agency storage prune`: clears the cache outright, and applies session
 *  retention if a policy is given. Cache alone is pruned unconditionally,
 *  since deleting it is defined to never lose data. */
export async function pruneCommand(
  sessionRetention?: RetentionPolicy,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  pruneCache(env);
  const lines = ["cache: cleared"];
  if (sessionRetention) {
    const { deleted } = await pruneSessions(sessionRetention, env);
    lines.push(`sessions: deleted ${deleted.length} file(s) past retention`);
  }
  return lines.join("\n");
}
