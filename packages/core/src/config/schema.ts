import type { Migration } from "@agency/schema";
import { z } from "zod";
import { CommandHooksSchema } from "../plugins/command-hooks.ts";

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
  /** Longest silence on a response stream before the request is cut, in ms. Default 5 minutes. */
  streamIdleMs: z.number().int().positive().optional(),
  /** Requests that the daemon sends to this provider in one minute, for all turns and workers together. Default 60. */
  requestsPerMinute: z.number().positive().optional(),
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

/** Well-known key gating real git writes (Todo 8 materialization checks it). */
export const GIT_WRITE_PERMISSION_KEY = "git_write" as const;
export const GitWriteDecisionSchema = z.enum(["allow", "ask", "deny"]);
export type GitWriteDecision = z.infer<typeof GitWriteDecisionSchema>;
/** Absent key means deny, preserving the current no-git-write posture. */
export const GIT_WRITE_DEFAULT: GitWriteDecision = "deny";

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
    /** The reviewer of `--permission-mode auto` as "provider/model". Default: `small_model`, else `model`. */
    auto_review_model: z.string().optional(),
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
    /** `auto` keeps the schemas of the MCP tools out of a request when there are more than 10, until the model loads them. */
    mcpDeferTools: z.enum(["auto", "always", "never"]).optional(),
    /**
     * Gives the model the `code` tool: one script that calls the other tools. `true` runs the script in an OS sandbox
     * (Linux, macOS). `"host"` runs it with the authority of a shell command.
     */
    codeMode: z.union([z.boolean(), z.literal("host")]).optional(),
    lspServers: z.record(z.string(), z.unknown()).optional(),
    /** The name of an output style: a Markdown file of `output-styles/` whose text joins the instructions. */
    outputStyle: z.string().optional(),
    /** The `memory` tool and its notes in the prompt of each session. Default true. */
    memory: z.boolean().optional(),
    /** Loads the code plugins of the user folders of OpenCode and Pi too. Off by default: they are code. */
    userAgentPlugins: z.boolean().optional(),
    /** `disabled`: names of skills that do not load, neither as a prompt line nor as `/name`. */
    skills: z.object({ disabled: z.array(z.string()).optional() }).optional(),
    /** Loads the user instructions of other agents (`~/.claude/CLAUDE.md`). Off by default: they are often about that agent. */
    userAgentInstructions: z.boolean().optional(),
    /**
     * Per-tool permission policy (allow/ask/deny, bare or pattern maps) plus the
     * `external_directory` key gating out-of-workspace access. Unlisted tools
     * default by risk tier: `safe` tools run freely, everything else asks.
     */
    permissions: z.record(z.string(), ToolPermissionSchema).default({}),
    /** Trust behavior: when `required`, tools above the `safe` risk tier refuse to run in an untrusted workspace. */
    trust: z.object({ required: z.boolean().default(false) }).default({ required: false }),
    /** Sandbox backend switch plus container options. Software is the default. */
    sandbox: z
      .object({
        /** Local in-process boundary or container exec. Invalid values fail load. */
        backend: z.enum(["software", "docker", "os"]).default("software"),
        /** With the `os` backend: shell commands get the network. Default: no network. */
        allowNetwork: z.boolean().optional(),
        /** With the `os` backend on Linux and macOS: shell commands reach only these hosts, through a proxy. */
        allowedDomains: z.array(z.string().min(1)).optional(),
        /** Image for one-shot `docker run` exec. */
        image: z.string().optional(),
        /** Existing container for `docker exec`; unset means `docker run --rm`. */
        container: z.string().optional(),
        /** Container-side mount point. Defaults to /workspace. */
        containerRoot: z.string().optional(),
        /** Docker CLI binary. Defaults to docker. */
        dockerBin: z.string().optional(),
        /**
         * Egress hostname allowlist for container runs. Undefined means
         * unrestricted (no `--network` flag, current behavior). Defined —
         * even empty — is deny-by-default: one-shot `docker run` gets
         * `--network=none` unless `network` names an explicit network.
         * Per-host enforcement lives at tool-policy level (`requireNetwork`
         * over capabilities), since plain `docker run` flags cannot express
         * hostname allowlists; the container network gate is the coarse lock.
         */
        egress: z.array(z.string().min(1)).optional(),
        /** Named Docker network for one-shot runs; honors explicit user intent. */
        network: z.string().min(1).optional(),
        /**
         * Linux capabilities to drop (`--cap-drop`); validated against the
         * known-good set at backend construction, unknown names fail boot.
         * `CAP_`-prefixed and lowercase spellings are accepted and canonicalized.
         */
        capDrop: z.array(z.string().min(1)).optional(),
        /** Names of environment variables that a shell command of the model does not get (tokens, keys). */
        denyEnv: z.array(z.string().min(1)).optional(),
        /** Names with KEY, SECRET or TOKEN that a shell command of the model still gets, such as `GH_TOKEN`. */
        allowEnv: z.array(z.string().min(1)).optional(),
        /** Pre-dispatch cost-forecast threshold (USD): a dispatch estimated above this asks before spawning. */
        forecastCostUsd: z.number().optional(),
      })
      .default({ backend: "software" }),
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
    websearch: z
      .object({
        endpoint: z.string().optional(),
        /** The OpenRouter model of a search when there is no endpoint. Default `deepseek/deepseek-v4-flash`. */
        model: z.string().optional(),
      })
      .optional(),
    /** Plugins to load via npm package names (e.g. ["my-agency-plugin"]). Discovery order: .agency/plugins/ -> user config plugins/ -> npm entries. */
    plugins: z.array(z.string()).optional(),
    /** Shell commands that run on agent events, in the format of Claude Code settings. Exit code 2 blocks. */
    hooks: CommandHooksSchema.optional(),
    fallback_model: z.string().optional(),
    /** Tool steps that one turn may take when the caller sets no limit. Absent means the loop default. */
    maxSteps: z.number().int().positive().optional(),
    /** Text for the model that writes the summary of a compaction: what the summary must keep. */
    compactionInstructions: z.string().optional(),
    /** Tokens of history at which a session is compacted when the window of the model is larger. Absent means 220000. */
    compactionLimit: z.number().int().positive().optional(),
    /** True: old results of re-runnable tools stay whole in each request, where by default they become a short note. */
    keepToolResults: z.boolean().optional(),
    /** False: a turn that changed code and ran no passing check after may end. By default it is sent back once. */
    verifyGate: z.boolean().optional(),
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
    const handles = Object.keys(data.agents);
    if (handles.length === 0) return;
    // As at run time: the leader is the agent that `leader` names, else the first of the roster.
    const handle = data.leader ?? handles[0] ?? "";
    if (data.agents[handle]?.enabled === false) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "leader agent must be enabled",
        path: ["agents", handle, "enabled"],
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

export const defaultConfig: Config = ConfigSchema.parse({
  schemaVersion: CONFIG_SCHEMA_VERSION,
});

/** Splits "provider/model" on the FIRST slash: model ids may contain more. */
export function parseModelRef(ref: string): { provider: string; model: string } | undefined {
  const slash = ref.indexOf("/");
  if (slash <= 0 || slash === ref.length - 1) return undefined;
  return { provider: ref.slice(0, slash), model: ref.slice(slash + 1) };
}
