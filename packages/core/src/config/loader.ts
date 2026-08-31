import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
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
    merged = { ...merged, ...sources.flags };
  }

  if (sources.managedPath) {
    const managedLayer = readLayer(sources.managedPath);
    if (managedLayer) merged = { ...merged, ...migrateLayer(managedLayer) };
  }

  return ConfigSchema.parse({ ...merged, schemaVersion: CONFIG_SCHEMA_VERSION });
}
