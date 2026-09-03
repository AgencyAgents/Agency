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

/**
 * One tool's permission entry (opencode's model): either a bare
 * `allow | ask | deny` — a bare `deny` removes the tool from the list offered
 * to the model entirely — or a per-subject pattern map evaluated with
 * LAST-matching-rule-wins, e.g. `{"bash": {"*": "ask", "git *": "allow",
 * "rm *": "deny"}}` (command subjects) or `{"write": {"*": "deny",
 * ".agency/plans/**": "allow"}}` (path subjects, workspace-relative).
 */
export const ToolPermissionSchema = z.union([
  z.enum(["allow", "ask", "deny"]),
  z.record(z.string(), z.enum(["allow", "ask", "deny"])),
]);
export type ToolPermission = z.infer<typeof ToolPermissionSchema>;

/** Tool name (or `external_directory`) -> bare decision or pattern map. */
export type PermissionsConfig = Record<string, ToolPermission>;

export const ConfigSchema = z.object({
  schemaVersion: z.literal(CONFIG_SCHEMA_VERSION),
  logLevel: z.enum(["debug", "info", "warn", "error"]).default("info"),
  locale: z.string().default("en"),
  /** Opt-in anonymous usage metrics; off by default, nothing recorded until set. */
  telemetryEnabled: z.boolean().default(false),
  /** Opt-in local crash reports feeding `agency debug`; off by default. */
  crashReportsEnabled: z.boolean().default(false),
  /** Config-defined providers, merged over the models.dev catalog. */
  provider: z.record(z.string(), ProviderConfigSchema).default({}),
  /** Default model as "provider/model"; the model id may itself contain "/". */
  model: z.string().optional(),
  /** Cheap model for background work (titles, compaction). */
  small_model: z.string().optional(),
  /**
   * TUI palette name (dark, light, high-contrast). Validated at render time:
   * an unknown name falls back to the default palette instead of erroring.
   */
  theme: z.string().optional(),
  disabled_providers: z.array(z.string()).default([]),
  enabled_providers: z.array(z.string()).optional(),
  /**
   * External MCP servers, name -> {command, args, env} or {url}. Kept as a
   * loose record here so the MCP config grammar evolves in @agency/tools,
   * which re-validates it via parseMcpServers at startup.
   */
  mcpServers: z.record(z.string(), z.unknown()).optional(),
  lspServers: z.record(z.string(), z.unknown()).optional(),
  /**
   * Per-tool permission policy (allow/ask/deny, bare or pattern maps) plus the
   * `external_directory` key gating out-of-workspace access. Unlisted tools
   * default by risk tier: `safe` tools run freely, everything else asks.
   */
  permissions: z.record(z.string(), ToolPermissionSchema).default({}),
  /** Trust behavior: when `required`, tools above the `safe` risk tier refuse to run in an untrusted workspace. */
  trust: z.object({ required: z.boolean().default(false) }).default({ required: false }),
  /** Sandbox-adjacent knobs beyond the permission maps. */
  sandbox: z
    .object({
      /** Pre-dispatch cost-forecast threshold (USD): a dispatch estimated above this asks before spawning. */
      forecastCostUsd: z.number().optional(),
    })
    .optional(),
  /**
   * Formatter run after every successful write/edit, e.g.
   * `formatter: {command: ["biome", "format", "--write"]}`; the file path is
   * appended as the final argument. Absent/empty means no formatter.
   */
  formatter: z.object({ command: z.array(z.string()).optional() }).optional(),
  /**
   * Which shell the bash tool actually spawns on Windows (powershell, gitbash
   * or cmd); other platforms always use POSIX sh. Defaults to powershell.
   */
  windowsShell: z.enum(["powershell", "gitbash", "cmd"]).optional(),
  /**
   * Web search for the websearch tool: a GET endpoint the query is appended
   * to as `?q=`. Absent means the tool is not offered to the model at all.
   */
  websearch: z.object({ endpoint: z.string().optional() }).optional(),
  /** Plugins to load via npm package names (e.g. ["my-agency-plugin"]). Discovery order: .agency/plugins/ -> user config plugins/ -> npm entries. */
  plugins: z.array(z.string()).optional(),
  fallback_model: z.string().optional(),
  trace: z
    .object({
      export: z
        .object({
          endpoint: z.string(),
          headers: z.record(z.string(), z.string()).optional(),
        })
        .optional(),
    })
    .optional(),
  task: z
    .object({
      maxDepth: z.number().int().min(1).optional(),
    })
    .optional(),
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
