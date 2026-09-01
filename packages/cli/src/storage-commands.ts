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
export function whereCommand(): string {
  const lines = [
    `config:  ${configDir()}`,
    `data:    ${dataDir()}`,
    `cache:   ${cacheDir()}`,
    `logs:    ${logDir()}`,
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

/** `agency storage`: size accounting by category. */
export function storageCommand(): string {
  const report = reportStorage();
  return [
    `data:   ${formatBytes(report.dataBytes)}  (${report.dataDir})`,
    `cache:  ${formatBytes(report.cacheBytes)}  (${report.cacheDir}, safe to delete)`,
    `logs:   ${formatBytes(report.logsBytes)}  (${report.logsDir})`,
  ].join("\n");
}

/** `agency storage prune`: clears the cache outright, and applies session
 *  retention if a policy is given. Cache alone is pruned unconditionally,
 *  since deleting it is defined to never lose data. */
export function pruneCommand(sessionRetention?: RetentionPolicy): string {
  pruneCache();
  const lines = ["cache: cleared"];
  if (sessionRetention) {
    const { deleted } = pruneSessions(sessionRetention);
    lines.push(`sessions: deleted ${deleted.length} file(s) past retention`);
  }
  return lines.join("\n");
}
