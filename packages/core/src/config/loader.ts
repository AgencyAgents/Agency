import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { migrate, type VersionedRecord } from "@agency/schema";
import { parse as parseJsonc } from "jsonc-parser";
import { configDir } from "../paths.ts";
import {
  CONFIG_SCHEMA_VERSION,
  type Config,
  ConfigSchema,
  configMigrations,
  DEFAULT_ROSTER,
  defaultConfig,
} from "./schema.ts";

/**
 * Precedence, lowest to highest. `managed` is admin/org policy and wins over
 * everything below it, including CLI flags: that's the point of a managed layer.
 */
export interface ConfigSources {
  globalDir?: string;
  projectRoot?: string;
  managedPath?: string;
  env?: NodeJS.ProcessEnv;
  /**
   * CLI-provided overrides (e.g. `--model`), sitting above env and below
   * managed. Build it with `configFlags` so command-level options and absent
   * flags can't masquerade as config. Must map onto Config keys; anything else
   * is dropped here.
   */
  flags?: Partial<Record<keyof Config, unknown>>;
}

const ENV_KEYS: Record<string, keyof Config> = {
  AGENCY_LOG_LEVEL: "logLevel",
  AGENCY_LOCALE: "locale",
  AGENCY_MODEL: "model",
  AGENCY_SMALL_MODEL: "small_model",
  AGENCY_THEME: "theme",
};

const TRUTHY = new Set(["1", "true", "yes", "on"]);

function envBoolean(value: string): boolean {
  return TRUTHY.has(value.trim().toLowerCase());
}

function envList(value: string): string[] {
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Merges `overlay` over `base`, recursing into plain objects so a layer that
 * sets one key of a record (e.g. a project config's `provider.<id>`) extends
 * the lower layer's record instead of replacing it wholesale. Arrays and
 * scalars always replace: a layer's list is that layer's whole intent.
 */
function deepMergeLayer(
  base: Record<string, unknown>,
  overlay: Record<string, unknown>,
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(overlay)) {
    const current = merged[key];
    if (isPlainObject(current) && isPlainObject(value)) {
      merged[key] = deepMergeLayer(current, value);
    } else {
      merged[key] = value;
    }
  }
  return merged;
}

function readLayer(path: string): Record<string, unknown> | undefined {
  if (!existsSync(path)) return undefined;
  const text = readFileSync(path, "utf8");
  const errors: unknown[] = [];
  const parsed = parseJsonc(text, errors as never, { allowTrailingComma: true }) as Record<string, unknown>;
  if (errors.length > 0) {
    throw new Error(`config at ${path} has invalid JSONC (${errors.length} error(s))`);
  }
  return parsed;
}

function migrateLayer(raw: Record<string, unknown>): Record<string, unknown> {
  const versioned: VersionedRecord = {
    schemaVersion: typeof raw.schemaVersion === "number" ? raw.schemaVersion : 0,
    ...raw,
  };
  const { schemaVersion: _v, ...rest } = migrate(versioned, configMigrations, CONFIG_SCHEMA_VERSION);
  return rest;
}

function envOverrides(env: NodeJS.ProcessEnv): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [envKey, configKey] of Object.entries(ENV_KEYS)) {
    const value = env[envKey];
    if (value !== undefined) out[configKey] = value;
  }
  if (env.AGENCY_TELEMETRY !== undefined) out.telemetryEnabled = envBoolean(env.AGENCY_TELEMETRY);
  if (env.AGENCY_CRASH_REPORTS !== undefined) {
    out.crashReportsEnabled = envBoolean(env.AGENCY_CRASH_REPORTS);
  }
  if (env.AGENCY_DISABLED_PROVIDERS !== undefined) {
    out.disabled_providers = envList(env.AGENCY_DISABLED_PROVIDERS);
  }
  if (env.AGENCY_ENABLED_PROVIDERS !== undefined) {
    out.enabled_providers = envList(env.AGENCY_ENABLED_PROVIDERS);
  }
  return out;
}

/**
 * Normalizes CLI flag overrides into the `flags` layer: only keys that exist
 * on the Config schema survive, and undefined values are dropped, so
 * command-level options (`--workspace`, `--format`, ...) and flags that
 * weren't passed can't clobber lower layers. Managed policy still wins over
 * anything passed here.
 */
export function configFlags(
  flags: Partial<Record<keyof Config, unknown>>,
): Partial<Record<keyof Config, unknown>> {
  const out: Partial<Record<keyof Config, unknown>> = {};
  for (const [key, value] of Object.entries(flags)) {
    if (key in ConfigSchema.shape && value !== undefined) {
      out[key as keyof Config] = value;
    }
  }
  return out;
}

export function loadConfig(sources: ConfigSources = {}): Config {
  const env = sources.env ?? process.env;
  let merged: Record<string, unknown> = { ...defaultConfig };

  const globalPath = join(sources.globalDir ?? configDir(env), "config.jsonc");
  const globalLayer = readLayer(globalPath);
  if (globalLayer) merged = deepMergeLayer(merged, migrateLayer(globalLayer));

  if (sources.projectRoot) {
    const projectLayer = readLayer(join(sources.projectRoot, ".agency", "config.jsonc"));
    if (projectLayer) merged = deepMergeLayer(merged, migrateLayer(projectLayer));
  }

  merged = deepMergeLayer(merged, envOverrides(env));

  if (sources.flags) {
    merged = deepMergeLayer(merged, configFlags(sources.flags) as Record<string, unknown>);
  }

  if (sources.managedPath) {
    const managedLayer = readLayer(sources.managedPath);
    if (managedLayer) merged = deepMergeLayer(merged, migrateLayer(managedLayer));
  }

  const config = ConfigSchema.parse({ ...merged, schemaVersion: CONFIG_SCHEMA_VERSION });

  // Fresh config with no agents key gets the default empty roster.
  if (!config.agents) {
    (config as Record<string, unknown>).agents = { ...DEFAULT_ROSTER };
  }

  return config;
}

/**
 * Persists a config change (onboarding's model/telemetry decisions) to the
 * global layer. The managed layer always wins on next load, so this can't
 * override policy. Note: an existing file's JSONC comments are not preserved.
 */
export function updateGlobalConfig(
  patch: Partial<Config>,
  sources: { globalDir?: string; env?: NodeJS.ProcessEnv } = {},
): Config {
  const globalPath = join(sources.globalDir ?? configDir(sources.env ?? process.env), "config.jsonc");
  const current = readLayer(globalPath);
  const merged = { ...(current ?? {}), ...patch, schemaVersion: CONFIG_SCHEMA_VERSION };
  mkdirSync(dirname(globalPath), { recursive: true });
  writeFileSync(globalPath, `${JSON.stringify(merged, null, 2)}\n`);
  return loadConfig({ globalDir: sources.globalDir, env: sources.env });
}
