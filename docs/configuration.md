# Configuration

Agency loads one `Config` from stacked layers, lowest to highest:

1. `defaultConfig` (in-code defaults)
2. Global file: `<configDir>/config.jsonc` (JSONC, trailing commas allowed)
3. Project file: `<projectRoot>/.agency/config.jsonc` (when a project root is given)
4. Environment variables (see below)
5. CLI flags layer (`--model` via `configFlags`; only known `Config` keys survive, unknown flags are dropped)
6. Managed file (`managedPath` when supplied) — wins over everything, including flags

Layers merge with `deepMergeLayer`: plain objects recurse (e.g. `provider.<id>` extends rather than replaces), arrays and scalars replace.

Global `configDir` per OS: Windows `%APPDATA%/Agency`, other platforms `~/.config/agency` (Linux respects `XDG_CONFIG_HOME`, macOS currently uses `~/.config/agency`). Project config is always `.agency/config.jsonc` under the workspace root.

Schema version is `2`; older files migrate via `configMigrations`. Validation is Zod (`ConfigSchema`); an invalid file throws.

## Config keys (ConfigSchema)

| Key | Type | Default | Notes |
|---|---|---|---|
| `schemaVersion` | `2` | `2` | Literal; migration target |
| `logLevel` | `debug\|info\|warn\|error` | `info` | Logger level |
| `locale` | string | `en` | Catalog locale |
| `telemetryEnabled` | boolean | `false` | Opt-in anonymous metrics |
| `crashReportsEnabled` | boolean | `false` | Opt-in crash reports for `agency debug` |
| `provider` | `Record<id, ProviderConfig>` | `{}` | Per-provider overrides (see below) |
| `model` | string | — | Default model as `provider/model` (model id may contain `/`) |
| `small_model` | string | — | Cheap model for background tasks |
| `theme` | string | — | Reserved for future frontend; unknown values ignored |
| `disabled_providers` | `string[]` | `[]` | Families to hide |
| `enabled_providers` | `string[]` | — | When set, only these families are kept |
| `mcpServers` | `Record<string, unknown>` | — | Loose map; re-validated by `parseMcpServers` at startup |
| `lspServers` | `Record<string, unknown>` | — | Same; parsed by `parseLspServers` |
| `permissions` | `Record<tool, allow\|ask\|deny \| Record<pattern, allow\|ask\|deny>>` | `{}` | See Permissions |
| `trust` | `{required: boolean}` | `{required:false}` | When true, `safe`-tier tools run in untrusted workspaces, `moderate`/`dangerous` require trust |
| `sandbox.forecastCostUsd` | number | — | Pre-dispatch cost threshold that triggers an ask |
| `formatter` | `{command?: string[]}` | — | Appended with the file path after each write/edit |
| `windowsShell` | `powershell\|gitbash\|cmd` | — | Windows only; default `powershell` |
| `websearch` | `{endpoint?: string}` | — | GET endpoint queried as `?q=`; absent = tool not offered |
| `plugins` | `string[]` | — | npm packages to load as plugins |
| `agents` | `Record<handle, {role, provider, model, effort, permissions?}>` | — | Swarm roster; handle `[a-z][a-z0-9-]*`; effort `off|minimal|low|medium|high|xhigh|max|auto` |
| `leader` | string | — | Handle of leader agent; defaults to first roster entry |
| `budgets` | `{perAgentUsd?, swarmUsd?}` | — | Token/cost ceilings per agent and swarm-wide |

### Agents presets (swarm roster)

Starter roster presets are editable config examples, not hardcoded. Example:

```jsonc
{
  "agents": {
    "marshal": { "role": "leader", "provider": "anthropic", "model": "claude-sonnet-5", "effort": "auto" },
    "surveyor": { "role": "planner", "provider": "anthropic", "model": "claude-sonnet-5", "effort": "high", "permissions": { "write": "deny", "edit": "deny", "bash": "deny" } },
    "skeptic": { "role": "reviewer", "provider": "openai", "model": "gpt-5.2", "effort": "high", "permissions": { "write": "deny", "edit": "deny", "bash": "deny" } },
    "smith": { "role": "coder", "provider": "anthropic", "model": "claude-sonnet-5", "effort": "medium" },
    "driver": { "role": "executor", "provider": "anthropic", "model": "claude-sonnet-5", "effort": "medium", "permissions": { "write": "deny", "edit": "deny" } },
    "scout": { "role": "explorer", "provider": "anthropic", "model": "claude-sonnet-5", "effort": "low", "permissions": { "write": "deny", "edit": "deny", "bash": "deny" } },
    "archivist": { "role": "researcher", "provider": "anthropic", "model": "claude-sonnet-5", "effort": "medium", "permissions": { "read": "deny", "write": "deny", "edit": "deny", "bash": "deny" } },
    "warden": { "role": "reviewer", "provider": "openai", "model": "gpt-5.2", "effort": "high", "permissions": { "write": "deny", "edit": "deny" } }
  },
  "leader": "marshal",
  "budgets": { "perAgentUsd": 5, "swarmUsd": 20 }
}
```

Worktree isolation: agents with write capabilities get `.agency/worktrees/<handle>`; read-only agents share the main workspace. Merge-back is manual or via leader instruction.

### ProviderConfig (`provider.<id>`)

`name?`, `baseUrl?`, `headers?: Record<string,string>`, `family?: openai|anthropic|google|openai-compatible` (default `openai-compatible` for config-defined providers), `env?: string[]` (extra env var names for the key), `apiKey?: string` (lowest precedence, local dev), `models?: Record<id, ModelOverride>`, `whitelist?`, `blacklist?`. `ModelOverride` may override `name`, `contextWindow`, `maxOutputTokens`, `pricing`, `capabilities`, `status`, `releaseDate`.

## Environment variable overrides

Mapped via `envOverrides`:

- `AGENCY_LOG_LEVEL` -> `logLevel`
- `AGENCY_LOCALE` -> `locale`
- `AGENCY_MODEL` -> `model`
- `AGENCY_SMALL_MODEL` -> `small_model`
- `AGENCY_THEME` -> `theme`
- `AGENCY_TELEMETRY` (`1`/`true`/`yes`/`on`) -> `telemetryEnabled`
- `AGENCY_CRASH_REPORTS` (same truthy set) -> `crashReportsEnabled`
- `AGENCY_DISABLED_PROVIDERS` (comma-separated) -> `disabled_providers`
- `AGENCY_ENABLED_PROVIDERS` (comma-separated) -> `enabled_providers`

Provider keys are resolved per turn as: declared `provider.<id>.env` entries, then `AGENCY_<PROVIDER>_API_KEY`, then keychain, then `provider.<id>.apiKey`.

## Providers and models

`--model provider/model` and `--provider` compose the active `model` ref via the flags layer. A bare `--provider` without `--model` reuses the model id from `config.model`. The daemon resolves model metadata offline from the on-disk catalog cache (`<cacheDir>/model-catalog.json`) or the built-in snapshot, merged with `provider` overrides — the turn path never fetches.

## Permissions

`permissions` maps a tool name (or `external_directory`) to a bare decision or a pattern map. Pattern maps use last-match-wins: e.g. `{"bash": {"*":"ask","git *":"allow","rm *":"deny"}}`. Path patterns match workspace-relative forward-slash paths. The daemon builds a `PermissionsGate`; the sandbox enforces `external_directory` and a deny-only `CommandPolicy` derived from `bash` deny patterns. Unknown/riskTier-less tools default to `allow` so that MCP/tool-injected tools are not spuriously gated — the trust and capability layers own those.

## MCP / LSP

Configured under `mcpServers` / `lspServers`. The MCP layer accepts stdio (`command`+`args`) and HTTP (`url`) servers, optional `headers`, and per-request timeouts. LSP is a minimal client that decorates read/write/edit results with diagnostics. Failures surface via `providers_list` / `mcp_status` / `lsp_status` RPC and per-turn `mcp_server_down` system reminders.

## Themes and keybinds (deferred — frontend follows separately)

`theme` is a config key reserved for the future frontend. Keybind and theme registries were part of the removed `packages/tui` package; the backend retains the config key but does not apply it. Frontend will rebuild from these config values.

## Writing config

`updateGlobalConfig(patch)` merges into the global JSONC file and returns the reloaded `Config`. Comments in an existing JSONC file are not preserved.
