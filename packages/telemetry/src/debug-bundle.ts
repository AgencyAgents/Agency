import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, statSync } from "node:fs";
import { join } from "node:path";
import { dataDir, logDir, storagePaths, workspaceId } from "@agency/core";
import type { Redactor } from "@agency/guard";

/**
 * `agency debug` bundle (P8): everything support needs to triage a report,
 * redacted through the R11 chokepoint before a single byte is written. The
 * bundle contains no config file bodies (they can carry keys) and no session
 * message content — only structure, sizes, and log tails.
 */

export interface DebugBundleOptions {
  workspaceRoot: string;
  redactor: Redactor;
  env?: NodeJS.ProcessEnv;
  platform?: string;
  version?: string;
  /** Injectable log reader for tests. */
  readLogTail?: (logPath: string, maxBytes: number) => string;
  /** Injectable session listing for tests. */
  listSessions?: (sessionsDir: string) => Array<{ id: string; bytes: number; entries: number }>;
}

export interface DebugBundle {
  generatedAt: string;
  version: string;
  platform: string;
  workspaceId: string;
  paths: { data: string; cache: string; logs: string };
  config: Record<string, unknown>;
  environment: Record<string, string>;
  storage: { sessions: number; snapshots: number; cache: number; logs: number };
  sessions: Array<{ id: string; bytes: number; entries: number }>;
  logTail: string;
}

const SENSITIVE_ENV_KEYS = /KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTH/i;

/** Allowlist, not blocklist: only environment facts that help diagnose a
 *  report are included, so an unlisted variable can never leak by omission. */
const SAFE_ENV_KEYS = [
  "OS",
  "TERM",
  "LANG",
  "LC_ALL",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "NODE_EXTRA_CA_CERTS",
  "AGENCY_LOG_LEVEL",
  "AGENCY_LOCALE",
  "AGENCY_SCREEN_READER",
  "NO_COLOR",
  "FORCE_COLOR",
];

function safeEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of SAFE_ENV_KEYS) {
    const value = env[key];
    if (value !== undefined && !SENSITIVE_ENV_KEYS.test(key)) out[key] = value;
  }
  return out;
}

function dirSizeBytes(dir: string): number {
  if (!existsSync(dir)) return 0;
  let total = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    total += entry.isDirectory() ? dirSizeBytes(full) : statSync(full).size;
  }
  return total;
}

function defaultReadLogTail(logPath: string, maxBytes: number): string {
  if (!existsSync(logPath)) return "";
  const stat = statSync(logPath);
  const start = Math.max(0, stat.size - maxBytes);
  const length = stat.size - start;
  const buffer = Buffer.alloc(length);
  const fd = openSync(logPath, "r");
  try {
    readSync(fd, buffer, 0, length, start);
  } finally {
    closeSync(fd);
  }
  return buffer.toString("utf8");
}

function defaultListSessions(sessionsDir: string): Array<{ id: string; bytes: number; entries: number }> {
  if (!existsSync(sessionsDir)) return [];
  const out: Array<{ id: string; bytes: number; entries: number }> = [];
  for (const workspace of readdirSync(sessionsDir, { withFileTypes: true })) {
    const workspaceDir = join(sessionsDir, workspace.name);
    if (!workspace.isDirectory()) continue;
    for (const file of readdirSync(workspaceDir)) {
      if (!file.endsWith(".jsonl")) continue;
      const full = join(workspaceDir, file);
      const bytes = statSync(full).size;
      const entries = readFileSync(full, "utf8")
        .split("\n")
        .filter((l) => l.trim().length > 0).length;
      out.push({ id: file.slice(0, -".jsonl".length), bytes, entries });
    }
  }
  return out;
}

/** Config keys safe to include verbatim; everything else is summarized as
 *  present/absent so a misconfigured key can still be diagnosed without
 *  shipping its value. */
const SAFE_CONFIG_KEYS = new Set([
  "schemaVersion",
  "logLevel",
  "locale",
  "telemetryEnabled",
  "crashReportsEnabled",
  "model",
  "small_model",
  "disabled_providers",
  "enabled_providers",
]);

export function buildDebugBundle(options: DebugBundleOptions): DebugBundle {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const paths = storagePaths(options.workspaceRoot, env, platform);
  const readLogTail = options.readLogTail ?? defaultReadLogTail;
  const listSessions = options.listSessions ?? defaultListSessions;

  const sessions = listSessions(paths.sessionsDir);
  const bundle: DebugBundle = {
    generatedAt: new Date().toISOString(),
    version: options.version ?? "0.1.0",
    platform,
    workspaceId: workspaceId(options.workspaceRoot),
    paths: { data: dataDir(env, platform), cache: paths.cacheDir, logs: logDir(env, platform) },
    config: {
      safeKeysPresent: [...SAFE_CONFIG_KEYS],
      providerCount: 0,
      providerIds: [] as string[],
    },
    environment: safeEnv(env),
    storage: {
      sessions: dirSizeBytes(paths.sessionsDir),
      snapshots: dirSizeBytes(paths.snapshotsDir),
      cache: dirSizeBytes(paths.cacheDir),
      logs: dirSizeBytes(paths.logsDir),
    },
    sessions,
    logTail: "",
  };

  // Config: never the file body. Which providers are configured (ids only)
  // is the one thing support actually needs and carries no secret.
  const configPath = paths.configPath;
  if (existsSync(configPath)) {
    try {
      const parsed = JSON.parse(readFileSync(configPath, "utf8")) as {
        provider?: Record<string, unknown>;
      };
      const providerIds = Object.keys(parsed.provider ?? {});
      bundle.config = {
        ...bundle.config,
        present: true,
        providerCount: providerIds.length,
        providerIds,
      };
    } catch {
      bundle.config = { ...bundle.config, present: true, parseError: true };
    }
  } else {
    bundle.config = { ...bundle.config, present: false };
  }

  const rawTail = readLogTail(join(logDir(env, platform), "agency.log"), 64 * 1024);
  bundle.logTail = options.redactor.redact(rawTail);

  return bundle;
}

/** Renders the bundle as the markdown body a user pastes into an issue. */
export function formatDebugBundle(bundle: DebugBundle): string {
  const lines = [
    `# Agency debug bundle`,
    ``,
    `- generated: ${bundle.generatedAt}`,
    `- version: ${bundle.version}`,
    `- platform: ${bundle.platform}`,
    `- workspace: ${bundle.workspaceId}`,
    ``,
    `## Paths`,
    ``,
    `- data: ${bundle.paths.data}`,
    `- cache: ${bundle.paths.cache}`,
    `- logs: ${bundle.paths.logs}`,
    ``,
    `## Config`,
    ``,
    "```json",
    JSON.stringify(bundle.config, null, 2),
    "```",
    ``,
    `## Storage (bytes)`,
    ``,
    `- sessions: ${bundle.storage.sessions}`,
    `- snapshots: ${bundle.storage.snapshots}`,
    `- cache: ${bundle.storage.cache}`,
    `- logs: ${bundle.storage.logs}`,
    ``,
    `## Sessions`,
    ``,
    ...(bundle.sessions.length > 0
      ? bundle.sessions.map((s) => `- ${s.id}: ${s.bytes} bytes, ${s.entries} entries`)
      : ["(none)"]),
    ``,
    `## Log tail (redacted)`,
    ``,
    "```",
    bundle.logTail || "(empty)",
    "```",
  ];
  return lines.join("\n");
}
