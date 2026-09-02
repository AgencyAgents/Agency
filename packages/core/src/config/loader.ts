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
};

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
  if (globalLayer) merged = { ...merged, ...migrateLayer(globalLayer) };

  if (sources.projectRoot) {
    const projectLayer = readLayer(join(sources.projectRoot, ".agency", "config.jsonc"));
    if (projectLayer) merged = { ...merged, ...migrateLayer(projectLayer) };
  }

  merged = { ...merged, ...envOverrides(env) };

  if (sources.flags) {
    merged = { ...merged, ...configFlags(sources.flags) };
  }

  if (sources.managedPath) {
    const managedLayer = readLayer(sources.managedPath);
    if (managedLayer) merged = { ...merged, ...migrateLayer(managedLayer) };
  }

  return ConfigSchema.parse({ ...merged, schemaVersion: CONFIG_SCHEMA_VERSION });
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
