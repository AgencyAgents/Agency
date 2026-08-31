import { z } from "zod";
import type { Migration } from "@agency/schema";

export const CONFIG_SCHEMA_VERSION = 1;

/**
 * v0 predates locale support. v1 adds it with an explicit default so old configs
 * keep working without the user noticing anything changed.
 */
export const configMigrations: Migration[] = [
  {
    from: 0,
    to: 1,
    migrate(record) {
      return { ...record, locale: "en" };
    },
  },
];

export const ConfigSchema = z.object({
  schemaVersion: z.literal(CONFIG_SCHEMA_VERSION),
  logLevel: z.enum(["debug", "info", "warn", "error"]).default("info"),
  locale: z.string().default("en"),
});

export type Config = z.infer<typeof ConfigSchema>;

export const defaultConfig: Config = ConfigSchema.parse({
  schemaVersion: CONFIG_SCHEMA_VERSION,
});
