import type { Migration } from "@agency/schema";
import { z } from "zod";

export const CONFIG_SCHEMA_VERSION = 2;

/**
 * v0 predates locale support. v1 adds it with an explicit default so old configs
 * keep working without the user noticing anything changed.
 * v2 adds the dynamic provider layer: per-provider overrides over the models.dev
 * catalog, default model selection, and provider enable/disable sets.
 */
export const configMigrations: Migration[] = [
  {
    from: 0,
    to: 1,
    migrate(record) {
      return { ...record, locale: "en" };
    },
  },
  {
    from: 1,
    to: 2,
    migrate(record) {
      // The provider keys are all optional; an old config needs no fields
      // added, only the version bump so the new schema accepts it.
      return { ...record };
    },
  },
];

const ModelOverrideSchema = z.object({
  name: z.string().optional(),
  contextWindow: z.number().int().nonnegative().optional(),
  maxOutputTokens: z.number().int().nonnegative().optional(),
  pricing: z
    .object({
      inputPerMTok: z.number().optional(),
      outputPerMTok: z.number().optional(),
      cachedInputPerMTok: z.number().optional(),
    })
    .optional(),
  capabilities: z
    .object({
      tools: z.boolean().optional(),
      vision: z.boolean().optional(),
      thinking: z.boolean().optional(),
    })
    .optional(),
  status: z.enum(["alpha", "beta", "deprecated", "active"]).optional(),
  releaseDate: z.string().optional(),
});

const ProviderConfigSchema = z.object({
  name: z.string().optional(),
  /** Overrides the provider's native API endpoint (gateways, proxies). */
  baseUrl: z.string().optional(),
  /** Extra headers sent with every request to this provider. */
  headers: z.record(z.string(), z.string()).optional(),
  /** Which adapter family speaks this provider's wire format. */
  family: z.enum(["openai", "anthropic", "google", "openai-compatible"]).optional(),
  /** Env var names that may hold this provider's key, beyond AGENCY_<ID>_API_KEY. */
  env: z.array(z.string()).optional(),
  /** A key set directly in config; lowest-precedence, mainly for local dev. */
  apiKey: z.string().optional(),
  models: z.record(z.string(), ModelOverrideSchema).optional(),
  whitelist: z.array(z.string()).optional(),
  blacklist: z.array(z.string()).optional(),
});

export const ConfigSchema = z.object({
  schemaVersion: z.literal(CONFIG_SCHEMA_VERSION),
  logLevel: z.enum(["debug", "info", "warn", "error"]).default("info"),
  locale: z.string().default("en"),
  /** Config-defined providers, merged over the models.dev catalog. */
  provider: z.record(z.string(), ProviderConfigSchema).default({}),
  /** Default model as "provider/model"; the model id may itself contain "/". */
  model: z.string().optional(),
  /** Cheap model for background work (titles, compaction). */
  small_model: z.string().optional(),
  disabled_providers: z.array(z.string()).default([]),
  enabled_providers: z.array(z.string()).optional(),
});

export type ModelOverrideConfig = z.infer<typeof ModelOverrideSchema>;
export type ProviderConfig = z.infer<typeof ProviderConfigSchema>;
export type Config = z.infer<typeof ConfigSchema>;

export const defaultConfig: Config = ConfigSchema.parse({
  schemaVersion: CONFIG_SCHEMA_VERSION,
});

/** Splits "provider/model" on the FIRST slash: model ids may contain more. */
export function parseModelRef(ref: string): { provider: string; model: string } | undefined {
  const slash = ref.indexOf("/");
  if (slash <= 0 || slash === ref.length - 1) return undefined;
  return { provider: ref.slice(0, slash), model: ref.slice(slash + 1) };
}
