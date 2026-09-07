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
  oauth: z
    .object({
      clientId: z.string().optional(),
      baseUrl: z.string().optional(),
    })
    .optional(),
});

/**
 * One tool's permission entry: either a bare
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

export const ConfigSchema = z
  .object({
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
    agents: z
      .record(
        z.string().regex(/^[a-z][a-z0-9-]*$/, "handle must match [a-z][a-z0-9-]*"),
        z.object({
          role: z.string().min(1),
          provider: z.string().min(1).optional(),
          model: z.string().min(1).optional(),
          effort: z.enum(["off", "minimal", "low", "medium", "high", "xhigh", "max", "auto"]).optional(),
          enabled: z.boolean().optional().default(false),
          permissions: z.record(z.string(), ToolPermissionSchema).optional(),
        }),
      )
      .optional(),
    leader: z
      .string()
      .regex(/^[a-z][a-z0-9-]*$/)
      .optional(),
    budgets: z
      .object({
        perAgentUsd: z.number().nonnegative().optional(),
        teamUsd: z.number().nonnegative().optional(),
        dailyUsd: z.number().nonnegative().optional(),
        monthlyUsd: z.number().nonnegative().optional(),
      })
      .optional(),
  })
  .superRefine((data, ctx) => {
    if (!data.agents) return;
    const entries = Object.keys(data.agents);
    if (entries.length === 0) return;
    const leader = data.agents.leader;
    if (!leader) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "leader agent is required when agents are configured",
        path: ["agents", "leader"],
      });
      return;
    }
    if (leader.enabled === false) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "leader agent must be enabled",
        path: ["agents", "leader", "enabled"],
      });
    }
    const enabledCount = Object.values(data.agents).filter((a) => a.enabled !== false).length;
    if (enabledCount === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "at least one agent must be enabled (leader is required)",
        path: ["agents"],
      });
    }
  });

export type ModelOverrideConfig = z.infer<typeof ModelOverrideSchema>;
export type ProviderConfig = z.infer<typeof ProviderConfigSchema>;
export type Config = z.infer<typeof ConfigSchema>;

/** One agent entry in the roster. */
export interface AgentConfig {
  role: string;
  /** Optional: when absent, the agent is disabled or not yet configured. */
  provider?: string;
  /** Optional: when absent, resolved at runtime from the provider catalog or global config.model. */
  model?: string;
  /** Optional: when absent, resolved at runtime from the model's supported efforts. */
  effort?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "auto";
  /** When false, the agent is not registered in the team and cannot be dispatched or @-addressed. Defaults to false. */
  enabled?: boolean;
  permissions?: Record<string, ToolPermission>;
}

/**
 * Starter roster shipped with every fresh config: 8 named roles, each an
 * ordinary `{role, provider, model, effort}` entry additionally carrying the
 * `permissions` map the Phase 2 gate reads per agent (unlisted tools are
 * denied, so each map is the role's full tool allowlist). Handles double as
 * role names. Leader is enabled, satisfying the schema's leader requirement.
 * Providers spread across vendors by role, so cross-provider adjudication
 * and heterogeneous routing work out of the box.
 */
export const DEFAULT_ROSTER: Record<string, AgentConfig> = {
  leader: {
    role: "leader",
    provider: "anthropic",
    model: "claude-sonnet-5",
    effort: "high",
    enabled: true,
    permissions: {
      read: "allow",
      write: "allow",
      edit: "allow",
      bash: "allow",
      glob: "allow",
      grep: "allow",
      fetch: "allow",
      websearch: "allow",
      dispatch: "allow",
      task: "allow",
      todo_read: "allow",
      todo_write: "allow",
      process_output: "allow",
      process_list: "allow",
      process_kill: "allow",
    },
  },
  planner: {
    role: "planner",
    provider: "openai",
    model: "gpt-5.2",
    effort: "high",
    enabled: true,
    permissions: {
      read: "allow",
      glob: "allow",
      grep: "allow",
      write: {
        "*": "deny",
        ".agency/plans/**": "allow",
        ".opencode/plans/**": "allow",
        ".omo/plans/**": "allow",
      },
      edit: {
        "*": "deny",
        ".agency/plans/**": "allow",
        ".opencode/plans/**": "allow",
        ".omo/plans/**": "allow",
      },
    },
  },
  "plan-reviewer": {
    role: "plan-reviewer",
    provider: "google",
    model: "gemini-3-pro",
    effort: "medium",
    enabled: true,
    permissions: {
      read: "allow",
      glob: "allow",
      grep: "allow",
    },
  },
  coder: {
    role: "coder",
    provider: "anthropic",
    model: "claude-sonnet-5",
    effort: "high",
    enabled: true,
    permissions: {
      read: "allow",
      glob: "allow",
      grep: "allow",
      write: {
        "*": "allow",
        ".agency/plans/**": "deny",
        ".opencode/plans/**": "deny",
        ".omo/plans/**": "deny",
      },
      edit: {
        "*": "allow",
        ".agency/plans/**": "deny",
        ".opencode/plans/**": "deny",
        ".omo/plans/**": "deny",
      },
      bash: "allow",
    },
  },
  executor: {
    role: "executor",
    provider: "openai",
    model: "gpt-5.2",
    effort: "medium",
    enabled: true,
    permissions: {
      read: "allow",
      bash: "allow",
      process_output: "allow",
      process_list: "allow",
      process_kill: "allow",
    },
  },
  explorer: {
    role: "explorer",
    provider: "google",
    model: "gemini-3-pro",
    effort: "low",
    enabled: true,
    permissions: {
      read: "allow",
      glob: "allow",
      grep: "allow",
    },
  },
  researcher: {
    role: "researcher",
    provider: "openai",
    model: "gpt-5.2",
    effort: "medium",
    enabled: true,
    permissions: {
      fetch: "allow",
      websearch: "allow",
    },
  },
  "code-reviewer": {
    role: "code-reviewer",
    provider: "google",
    model: "gemini-3-pro",
    effort: "medium",
    enabled: true,
    permissions: {
      read: "allow",
      glob: "allow",
      grep: "allow",
      bash: "allow",
    },
  },
};

export const defaultConfig: Config = ConfigSchema.parse({
  schemaVersion: CONFIG_SCHEMA_VERSION,
});

/** Splits "provider/model" on the FIRST slash: model ids may contain more. */
export function parseModelRef(ref: string): { provider: string; model: string } | undefined {
  const slash = ref.indexOf("/");
  if (slash <= 0 || slash === ref.length - 1) return undefined;
  return { provider: ref.slice(0, slash), model: ref.slice(slash + 1) };
}
