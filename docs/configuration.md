# Configuration

Agency loads one `Config` from stacked layers, lowest to highest:

1. `defaultConfig` (in-code defaults)
2. Global file: `<configDir>/config.jsonc` (JSONC, trailing commas allowed)
3. Project file: `<projectRoot>/.agency/config.jsonc` (when a project root is given)
4. Environment variables (see below)
5. CLI flags layer (`--model` via `configFlags`; only known `Config` keys survive, unknown flags are dropped)
6. Managed file (`managedPath` when supplied) — wins over everything, including flags

Layers merge with `deepMergeLayer`: plain objects recurse (e.g. `provider.<id>` extends rather than replaces), arrays and scalars replace.

The daemon keeps the config it started with. An idle daemon exits within one second of a change to the global file or the project file, so the next command starts a daemon with the new config. A turn that is in progress finishes on the old config. A command that starts in the same second as the change can run on the old config, or fail once with "connection to daemon closed" if the daemon stops while it connects; run the command again.

Global `configDir` per OS: Windows `%APPDATA%/Agency`, other platforms `~/.config/agency` (Linux respects `XDG_CONFIG_HOME`). macOS note: only the *config* file lives under `~/.config/agency`; user data goes to `~/Library/Application Support/Agency` and the regenerable cache to `~/Library/Caches/Agency` (see `agency where`). Project config is always `.agency/config.jsonc` under the workspace root.

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
| `sandbox.backend` | `software\|docker` | `software` | Sandbox backend: in-process boundary or container exec |
| `sandbox.image` | string | — | Image for one-shot `docker run` exec |
| `sandbox.container` | string | — | Existing container for `docker exec`; unset means `docker run --rm` |
| `sandbox.containerRoot` | string | — | Container-side mount point; defaults to `/workspace` |
| `sandbox.dockerBin` | string | — | Docker CLI binary; defaults to `docker` |
| `sandbox.egress` | `string[]` | — | Egress hostname allowlist; defined (even empty) is deny-by-default (see Sandbox) |
| `sandbox.network` | string | — | Named Docker network for one-shot runs; wins over the egress default |
| `sandbox.capDrop` | `string[]` | — | Linux capabilities to drop (`--cap-drop`); unknown names fail boot |
| `sandbox.forecastCostUsd` | number | — | Pre-dispatch cost threshold that triggers an ask |
| `formatter` | `{command?: string[]}` | — | Appended with the file path after each write/edit |
| `windowsShell` | `powershell\|gitbash\|cmd` | — | Windows only. With no value: `gitbash` when Git for Windows is installed (its `bin\bash.exe`, found from `git` on PATH), otherwise `powershell`. Models write bash with far fewer errors than Windows PowerShell 5.1 |
| `websearch` | `{endpoint?: string}` | — | GET endpoint queried as `?q=`; absent = tool not offered |
| `plugins` | `string[]` | — | npm packages to load as plugins |
| `hooks` | `Record<event, {matcher?, hooks: {type: "command", command, timeout?}[]}[]>` | — | Shell commands that run on agent events (see Hooks) |
| `agents` | `Record<handle, {role, provider, model, effort, permissions?}>` | — | Team roster; handle `[a-z][a-z0-9-]*`; effort `off|minimal|low|medium|high|xhigh|max|auto` |
| `leader` | string | — | Handle of leader agent; defaults to first roster entry |
| `budgets` | `{perAgentUsd?, teamUsd?, dailyUsd?, monthlyUsd?}` | — | Per-agent and team ceilings plus daemon-wide daily and monthly hard caps that refuse before the first provider call |

### Agents presets (team roster)

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
  "budgets": { "perAgentUsd": 5, "teamUsd": 20, "dailyUsd": 50, "monthlyUsd": 500 }
}
```

Worktree isolation: an agent that can write gets a git worktree at `.agency/worktrees/<session>/<handle>`; read-only agents share the main workspace. The shell and the file tools of the agent both work in that worktree, so a relative path is a path in the worktree. The worktree starts at the last commit, so uncommitted changes of the workspace are not in it. The dispatch result names the worktree and its branch. Merge-back is manual or via leader instruction.

### ProviderConfig (`provider.<id>`)

`name?`, `baseUrl?`, `headers?: Record<string,string>`, `family?: openai|anthropic|google|openai-compatible` (default: the native family for the ids `anthropic`, `openai` and `google`, otherwise `openai-compatible`; with a native family, `baseUrl` replaces the public endpoint up to the version segment, for example `https://gateway.example/v1` for Anthropic and OpenAI or `https://gateway.example/v1beta` for Google, and `headers` are sent with each request), `env?: string[]` (extra env var names for the key), `apiKey?: string` (lowest precedence, local dev), `streamIdleMs?: number` (the longest silence on a response stream before the request is cut, in ms; default 300000; a slow local server that takes more than 5 minutes to read a long prompt needs a larger value), `models?: Record<id, ModelOverride>`, `whitelist?`, `blacklist?`, `oauth?: {clientId?, baseUrl?}`. `ModelOverride` may override `name`, `contextWindow`, `maxOutputTokens`, `pricing`, `capabilities`, `status`, `releaseDate`.

### OAuth (`provider.<id>.oauth`)

`agency auth login <provider> --oauth` runs the PKCE browser flow for `anthropic`, `openai`, `google`, or `github-copilot` and stores the token in the OS keychain under the single canonical `<provider>:oauth` slot. The shipped client ids are placeholders: register an OAuth app at the provider's developer console and provision it via config:

```jsonc
{
  "provider": {
    "anthropic": { "oauth": { "clientId": "your-client-id" } }
  }
}
```

Without a configured `clientId` the login and any token refresh fail with an explicit auth error (a failed refresh never silently reuses the stale token — re-run `auth login <provider> --oauth`). `baseUrl` optionally points the authorize/token endpoints at a self-hosted gateway (`<baseUrl>/authorize`, `<baseUrl>/token`).

Registration is a human step per provider; no shipped client id is functional and none is baked in:

- Anthropic: create an OAuth client in the Anthropic console, allow the loopback redirect the login prints, then set `provider.anthropic.oauth.clientId`.
- OpenAI: same shape in the OpenAI developer dashboard, then `provider.openai.oauth.clientId`.
- Google: create an OAuth client ID of Desktop-app type in the Google Cloud console, then set `provider.google.oauth.clientId`. A human completes the consent screen once; agency stores the token and refreshes it.
- GitHub Copilot: prefer the RFC 8628 device flow (`agency auth login github-copilot --device`), which needs no browser redirect: `requestDeviceAuthorization` returns the user code, `pollDeviceToken` polls until approval, and `runDeviceFlow` stores the token. `supportsDeviceFlow` reports `github-copilot` as the only opted-in provider today.

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
- `AGENCY_SANDBOX_BACKEND` -> `sandbox.backend`
- `AGENCY_SANDBOX_IMAGE` -> `sandbox.image`
- `AGENCY_SANDBOX_CONTAINER` -> `sandbox.container`
- `AGENCY_SANDBOX_CONTAINER_ROOT` -> `sandbox.containerRoot`
- `AGENCY_SANDBOX_DOCKER_BIN` -> `sandbox.dockerBin`
- `AGENCY_SANDBOX_EGRESS` (comma-separated) -> `sandbox.egress`
- `AGENCY_SANDBOX_NETWORK` -> `sandbox.network`
- `AGENCY_SANDBOX_CAP_DROP` (comma-separated) -> `sandbox.capDrop`
- `AGENCY_GIT_WRITE` (`allow|ask|deny`) -> `permissions.git_write` (invalid values fail load via Zod)
- `AGENCY_MODELS_URL` -> model catalog source URL (default `https://models.opencode.ai/api.json`; `OPENCODE_MODELS_URL` still honored as a one-release fallback)
- `AGENCY_DISABLE_MODELS_FETCH` (set to anything) -> serve the catalog from disk cache or the builtin snapshot without fetching (`OPENCODE_DISABLE_MODELS_FETCH` still honored as a one-release fallback)

Provider keys are resolved per turn as: declared `provider.<id>.env` entries, then `AGENCY_<PROVIDER>_API_KEY`, then the provider's own name `<PROVIDER>_API_KEY` (for `google`: `GEMINI_API_KEY`, then `GOOGLE_API_KEY`), then keychain, then `provider.<id>.apiKey`. In both names a character of the id that is not a letter or a digit becomes `_`: the id `my-gateway` gives `AGENCY_MY_GATEWAY_API_KEY`.

## Providers and models

`--model provider/model` and `--provider` compose the active `model` ref via the flags layer. A bare `--provider` without `--model` reuses the model id from `config.model`, falling back to that provider's catalog default (newest catalog model for the family) when no config model is set. The daemon resolves model metadata offline from the on-disk catalog cache (`<cacheDir>/model-catalog.json`) or the built-in snapshot, merged with `provider` overrides. The turn path fetches in one case only, the OpenRouter model list below.

The ids `openrouter`, `deepseek`, `groq` and `xai` need no config entry. Each uses its public OpenAI-compatible endpoint, and `provider.<id>.baseUrl` replaces it. This run was made against OpenRouter with the key in `OPENROUTER_API_KEY`:

```sh
agency -p "Reply with the one word: ok" --model openrouter/deepseek/deepseek-v4-flash
```

An OpenRouter model that has no catalog entry and no config entry gets its limits from OpenRouter's public model list. The daemon reads the list one time, with no key, at the first turn on such a model. It takes the context window, the prices, and an output limit of at most 32000 tokens and at most a quarter of the window. If the read fails, the defaults stay: a window of 200000 tokens and an output limit of 8192. A config entry for the model stops the read for that model.

### Local model server

A server that speaks the OpenAI chat completions format is a config-defined provider. This example was run against a llama.cpp `llama-server` (build b11155, started with `--jinja -c 12288`):

```jsonc
{
  "provider": {
    "local": {
      "baseUrl": "http://127.0.0.1:8080/v1",
      "apiKey": "none",
      "models": { "qwen": { "contextWindow": 12288, "maxOutputTokens": 1024 } }
    }
  }
}
```

Run it with `--model local/qwen`. Notes:

- `apiKey` is necessary. For a server with no key, set any text.
- Set `contextWindow` to the context size of the server. Compaction uses this value. If the value is larger than the real size, the server rejects a request that is too long, and the conversation is then compacted and sent again.
- A llama.cpp server sends nothing while it reads the prompt. If that takes more than 5 minutes, the request is cut and sent again. Set `streamIdleMs` on the provider to a larger value to prevent the cut.

## Project instructions

The daemon adds `AGENTS.md`, `CLAUDE.md` (nearest directory first) and `.agency/rules/*.md` to the system prompt through `loadInstructions`, but only for a trusted workspace: repo-provided text is an injection surface. Run `agency trust` in the workspace, or accept the trust question in `agency onboard`. In an untrusted workspace the files are skipped and the CLI prints a one-line notice. A client that sends `systemPromptParts.instructions` replaces the daemon-loaded list.

The same rule applies to `.agency/plugins/`, `.agency/skills/`, `.agency/agents/` and `.agency/commands/` of the workspace. A plugin file is code that runs inside the daemon, an agent file can give its agent tools, and a command file can hold shell blocks, so the daemon loads them only for a trusted workspace. In an untrusted workspace the team is the roster from the config and the user config directory, and the daemon writes no default agent files. The text of each loaded skill and the `agentsMd` text of each loaded plugin are added after the project instructions. Plugins, skills, agents and commands in the user config directory load in every workspace.

## Permissions

`permissions` maps a tool name (or `external_directory`) to a bare decision or a pattern map. Pattern maps use last-match-wins: e.g. `{"bash": {"*":"ask","git *":"allow","rm *":"deny"}}`. Path patterns match workspace-relative forward-slash paths. The daemon builds a `PermissionsGate`; the sandbox enforces `external_directory` and a deny-only `CommandPolicy` derived from `bash` deny patterns. A tool with no entry runs when its risk tier is `safe` and asks otherwise; a tool with no risk tier (an MCP tool) asks.

A headless run (`-p`) has no approval surface, so an ask refuses at once. `--permission-mode` sets how one run answers asks: `ask` (default) refuses, `allow-edits` allows `write` and `edit`, `allow-all` allows every tool, `deny` refuses every tool above `safe`. No mode overrides a `deny` entry, the `.env` read block or the trust gate.

An agent of the team has its own `permissions` map in its roster entry. That map never gives the agent more than the run has. For each tool call the stricter verdict of the agent's map and the global `permissions` wins, and the mode of the run answers the asks. In the default mode a dispatched agent can only read. `--permission-mode allow-edits` lets it use `write` and `edit`, and `--permission-mode allow-all` or an `allow` entry in the global `permissions` lets it use the tools that its own map allows.

One turn takes at most 25 tool steps. A run that reaches the limit prints `iteration_limit` and exits with code 1. `--max-steps <n>` sets the limit for one run.

`permissions.git_write` (`allow|ask|deny`, default `deny`) gates real git writes: Todo 8 materialization calls `assertGitWriteAllowed` (packages/guard/src/git-write.ts) before creating commits. `allow` proceeds, `ask` routes through the existing `approval_requested` / `approval_respond` RPC surface (`once`/`always` proceed, `reject`/timeout deny), `deny` refuses with typed `PERMISSION_DENIED`. Non-interactive runs always deny regardless of setting. Only bare decisions are read; pattern maps and unknown values fail closed to `deny`.

## Sandbox

Two backends, selected by `sandbox.backend` (`software`, the default, or `docker`):

- `software` runs commands in-process behind `SandboxBoundary` (path containment + command policy). No daemon, no probe, no added boot latency.
- `docker` runs commands across a volume mount via `DockerSandboxBackend`: `docker exec` against `sandbox.container` when set, otherwise one-shot `docker run --rm` with `sandbox.image` (defaults to `alpine`). Construction is side-effect free; no container is created and no daemon is contacted until exec/probe runs.

Fail-closed, never silent fallback: when `sandbox.backend` is `docker` but no daemon answers `docker info`, daemon boot throws a typed `AgencyError` (`internal`) telling the operator to start the Docker daemon or set `sandbox.backend` to `software` (`AGENCY_SANDBOX_BACKEND=software`). The check runs at boot — before any RPC is served — so a misconfigured daemon refuses to serve rather than running turns against an unintended backend. There is no code path that falls back to software: backend selection (`createSandboxBackend`) is a pure branch on config, and the boot gate (`ensureSandboxAvailable`) only probes container-backed backends (capability-checked, so software never pays for a probe).

Egress (deny-by-default once configured): `sandbox.egress` undefined means unrestricted (no `--network` flag, current behavior). A defined allowlist — even empty — isolates one-shot `docker run` with `--network=none`, unless `sandbox.network` names an explicit network (explicit intent wins, including without egress). Per-hostname enforcement is deliberately NOT at the container-flag level — plain `docker run` flags cannot express hostname allowlists — so the allowlist itself is enforced at tool-policy level (`requireNetwork` over `capabilities.network`, the same gate `fetch`/`browser`/`websearch` use); the `--network` flag is the coarse container-level lock. DNS-level filtering inside the container is out of reach and not claimed.

Capability drops: `sandbox.capDrop` entries map to `--cap-drop` flags on one-shot `docker run`, validated against the known-good Linux capability set (`capabilities(7)`); `CAP_`-prefixed and lowercase spellings canonicalize, unknown names throw a typed error at backend construction (daemon boot fails fast). Pinned-container caveat: `docker exec` cannot set network or capabilities — the container's network/caps are fixed at creation — so `egress`/`network`/`capDrop` apply to one-shot `docker run` only; operators pinning `sandbox.container` must configure that container's network and caps out of band.

## Session goal

A session can hold a goal: a condition that must be true before a turn ends. When the model ends a turn, the daemon asks the model of that turn if the newest part of the transcript shows that the goal is met. If it does not, the model gets the reason as a message and the turn goes on. When the goal is met, the daemon clears it.

- `agency -p "<prompt>" --session <id> --goal "<condition>"` sets the goal for a headless run. `--goal` needs `--session` or `--continue`.
- `/goal <session> <condition>` sets it, `/goal <session> clear` removes it, and `/goal <session>` shows it. The `session_send` RPC takes it as `goal`.
- The step limit still applies (`--max-steps`, 25 by default). A turn that reaches it ends with the goal in place, and the next turn of the session checks it again.
- Each check is one more request to the model. It is not in the usage numbers of the turn.
- A check that fails, or a reply that is not a verdict, does not hold the turn.

The team report that `/goal` showed before is now `/report [outcome]`.

## Compaction

A session is compacted when its history reaches 90 percent of the model's context window, and again when the provider reports a context overflow in the middle of a turn. The older messages become one summary, and the newest messages stay as they are. Task lists always stay.

The model of the session writes the summary: one more request, on the transcript of the older messages with long tool results cut short. The summary has fixed sections: the user's requests and rules, decisions, files read and changed, commands and results, errors and fixes, the state of the work, and the next step. If that request fails, or no key resolves for the provider, the daemon uses an offline summary that keeps only the first and the last lines of the transcript.

`/compact <session> [provider/model]` compacts a session at any size.

## Hooks

`hooks` holds shell commands that run on agent events. The format is the hook format of Claude Code settings, so a hook block from a Claude Code `settings.json` works here without changes.

```jsonc
{
  "hooks": {
    "PreToolUse": [{ "matcher": "Bash", "hooks": [{ "type": "command", "command": "python check_command.py" }] }],
    "Stop": [{ "hooks": [{ "type": "command", "command": "bun test", "timeout": 300 }] }]
  }
}
```

| Event | When it runs | Effect of a block |
|---|---|---|
| `PreToolUse` | Before each tool call | The tool does not run. The model gets the reason as the tool result. |
| `PostToolUse` | After each tool call | The reason is added to the tool result. |
| `UserPromptSubmit` | Before the model sees a prompt | The turn fails with the reason, and the prompt is removed from the session. |
| `SessionStart` | Before the first prompt of a session | None. |
| `Stop` | When the model ends its turn | The turn goes on. The model gets the reason as a message. |

Each command gets the event as JSON on stdin: `hook_event_name`, `cwd`, `session_id`, and the fields of the event (`tool_name`, `tool_input`, `tool_response`, `prompt`, `stop_hook_active`). `CLAUDE_PROJECT_DIR` and `AGENCY_PROJECT_DIR` hold the workspace path. The command runs in the workspace through the system shell (`cmd.exe` on Windows, `sh` elsewhere).

- Exit code 2 is a block, and stderr is the reason. So is exit code 0 with `{"decision": "block", "reason": "..."}` on stdout, or with `hookSpecificOutput.permissionDecision` set to `deny`.
- Any other exit code that is not 0 is a failed hook. It does not block.
- Stdout of a `UserPromptSubmit` or `SessionStart` command is given to the model as context and stays in the session. `hookSpecificOutput.additionalContext` does the same.
- `matcher` is a regular expression on the tool name, with no regard to case, so `Bash` matches the `bash` tool and `Edit|Write` matches `edit` and `write`. With no matcher, the commands run for every tool.
- `timeout` is in seconds. The default is 60. A command that runs longer is stopped, and it does not block.
- `Stop` hooks do not run for subagents. A `Stop` hook that always blocks keeps the turn going until the step limit, so let it pass when `stop_hook_active` is true or when its condition is met.

The daemon reads `hooks` only from the user config, so a workspace cannot add hooks. A plugin module can do the same from code: a handler of `tool.execute.before`, `tool.execute.after` or `turn.stop` that returns `{ block: "reason" }` blocks in the same way.

## MCP / LSP

Configured under `mcpServers` / `lspServers`. The MCP layer accepts stdio (`command`+`args`) and HTTP (`url`) servers, optional `headers`, and per-request timeouts. LSP is a minimal client that decorates read/write/edit results with diagnostics. Failures surface via `providers_list` / `mcp_status` / `lsp_status` RPC and per-turn `mcp_server_down` system reminders.

## Themes and keybinds (deferred — frontend follows separately)

`theme` is a config key reserved for the future frontend. Keybind and theme registries were part of the removed `packages/tui` package; the backend retains the config key but does not apply it. Frontend will rebuild from these config values.

## Writing config

`updateGlobalConfig(patch)` merges into the global JSONC file and returns the reloaded `Config`. Comments in an existing JSONC file are not preserved.
