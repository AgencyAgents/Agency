# Configuration

Agency loads one `Config` from stacked layers, lowest to highest:

1. `defaultConfig` (in-code defaults)
2. Global file: `<configDir>/config.jsonc` (JSONC, trailing commas allowed)
3. Project file: `<projectRoot>/.agency/config.jsonc` (when a project root is given)
4. Environment variables (see below)
5. CLI flags layer (`--model` via `configFlags`; only known `Config` keys survive, unknown flags are dropped)
6. Managed file (`managedPath` when supplied) — wins over everything, including flags

Layers merge with `deepMergeLayer`: plain objects recurse (e.g. `provider.<id>` extends rather than replaces), arrays and scalars replace.

The daemon keeps the config it started with. An idle daemon exits within one second of a change to the global file, the project file, the trust list or a hook file of the workspace, so the next command starts a daemon with the new config. A command that starts directly after the change also gets a new daemon: a daemon with no client refuses the first client when one of these files changed, and the command starts a new daemon. A turn that is in progress finishes on the old config, and a daemon that has a client stays until the client leaves.

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
| `auto_review_model` | string | — | Reviewer of `--permission-mode auto` as `provider/model`. Default: `small_model`, else `model` |
| `theme` | string | — | Reserved for future frontend; unknown values ignored |
| `disabled_providers` | `string[]` | `[]` | Families to hide |
| `enabled_providers` | `string[]` | — | When set, only these families are kept |
| `mcpServers` | `Record<string, unknown>` | — | Loose map; re-validated by `parseMcpServers` at startup |
| `codeMode` | `true \| false \| "host"` | `false` | Gives the model the `code` tool: one script that calls the other tools. `true` runs the script in an OS sandbox with no network, no write access and, of your files, only those of the runner: bubblewrap on Linux, Seatbelt on macOS, an AppContainer with no capability on Windows (the container `agency.script` gets read access to the runner file at the start of the daemon; it writes only in its own temporary folder). `"host"` runs it with no isolation, with the authority of a shell command, and only with the `software` sandbox backend. On Windows the sandbox of `true` ran on this machine: a script read its input and called tools, and its read of a user file, its write and its network call were refused. On Linux and macOS it never ran: tests cover its arguments only |
| `mcpDeferTools` | `"auto" \| "always" \| "never"` | `"auto"` | When the schemas of the MCP tools stay out of a request until the model loads them (see MCP / LSP) |
| `lspServers` | `Record<string, unknown>` | — | Same; parsed by `parseLspServers` |
| `outputStyle` | string | — | The name of an output style: its text joins the instructions (see Output styles) |
| `memory` | boolean | `true` | The `memory` tool and its notes in the prompt (see Memory) |
| `userAgentPlugins` | boolean | `false` | Also loads the code plugins of the user folders of OpenCode and Pi (see Plugins of other agents) |
| `userAgentInstructions` | boolean | `false` | Also loads the user instruction files of other agents, such as `~/.claude/CLAUDE.md` (see Projects of other agents) |
| `permissions` | `Record<tool, allow\|ask\|deny \| Record<pattern, allow\|ask\|deny>>` | `{}` | See Permissions |
| `trust` | `{required: boolean}` | `{required:false}` | When true, `safe`-tier tools run in untrusted workspaces, `moderate`/`dangerous` require trust |
| `sandbox.backend` | `software\|docker\|os` | `software` | Sandbox backend: in-process boundary, container exec, or the sandbox of the operating system |
| `sandbox.allowNetwork` | `boolean` | `false` | With the `os` backend: shell commands get the network. On Windows it must be `true` |
| `sandbox.allowedDomains` | `string[]` | unset | With the `os` backend on Linux and macOS: shell commands reach only these hosts, through a proxy. See [Sandbox of the operating system](#sandbox-of-the-operating-system) |
| `sandbox.image` | string | — | Image for one-shot `docker run` exec |
| `sandbox.container` | string | — | Existing container for `docker exec`; unset means `docker run --rm` |
| `sandbox.containerRoot` | string | — | Container-side mount point; defaults to `/workspace` |
| `sandbox.dockerBin` | string | — | Docker CLI binary; defaults to `docker` |
| `sandbox.egress` | `string[]` | — | Egress hostname allowlist; defined (even empty) is deny-by-default (see Sandbox) |
| `sandbox.network` | string | — | Named Docker network for one-shot runs; wins over the egress default |
| `sandbox.capDrop` | `string[]` | — | Linux capabilities to drop (`--cap-drop`); unknown names fail boot |
| `sandbox.denyEnv` | `string[]` | — | Names of environment variables that a shell command of the model does not get (see Sandbox) |
| `sandbox.allowEnv` | `string[]` | — | Names with KEY, SECRET or TOKEN that a shell command of the model still gets, for example `["GH_TOKEN"]` (see Sandbox) |
| `sandbox.forecastCostUsd` | number | — | Pre-dispatch cost threshold that triggers an ask |
| `formatter` | `{command?: string[]}` | — | Appended with the file path after each write/edit |
| `windowsShell` | `powershell\|gitbash\|cmd` | — | Windows only. With no value: `gitbash` when Git for Windows is installed (its `bin\bash.exe`, found from `git` on PATH), otherwise `powershell`. Models write bash with far fewer errors than Windows PowerShell 5.1 |
| `websearch` | `{endpoint?: string, model?: string}` | — | `endpoint`: a GET endpoint queried as `?q=`. With no endpoint, the `websearch` tool searches through the web plugin of OpenRouter when the `openrouter` provider has a key, with `model` (default `deepseek/deepseek-v4-flash`): 5 results with title, URL and an excerpt. Measured: 0.0072 USD for 3 results, about 1 cent a search; this cost is not in the cost of the turn. With neither, the tool is not offered |
| `plugins` | `string[]` | — | npm packages to load as plugins |
| `compactionInstructions` | string | — | Text for the model that writes the summary of a compaction: what the summary must keep. It goes after the built-in rules and comes first where the two disagree. It has no effect on the offline summary |
| `compactionLimit` | number | `220000` | Tokens of history at which a session is compacted when the window of the model is larger. A smaller window is compacted at 90 percent of its size |
| `maxSteps` | number | — | Tool steps that one turn may take when the caller sets no limit. With no value: 100 |
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

`name?`, `baseUrl?`, `headers?: Record<string,string>`, `family?: openai|anthropic|google|openai-compatible` (default: the native family for the ids `anthropic`, `openai` and `google`, otherwise `openai-compatible`; with a native family, `baseUrl` replaces the public endpoint up to the version segment, for example `https://gateway.example/v1` for Anthropic and OpenAI or `https://gateway.example/v1beta` for Google, and `headers` are sent with each request), `env?: string[]` (extra env var names for the key), `apiKey?: string` (lowest precedence, local dev), `requestsPerMinute?: number` (requests of the daemon to this provider in one minute; default: the rate of the API of a known provider, 60 for any other), `streamIdleMs?: number` (the longest silence on a response stream before the request is cut, in ms; default 300000; a slow local server that takes more than 5 minutes to read a long prompt needs a larger value), `models?: Record<id, ModelOverride>`, `whitelist?`, `blacklist?`, `oauth?: {clientId?, baseUrl?}`. `ModelOverride` may override `name`, `contextWindow`, `maxOutputTokens`, `pricing`, `capabilities`, `status`, `releaseDate`.

### ChatGPT plan (`chatgpt`)

`agency auth login chatgpt` signs in with ChatGPT in the browser, and the models of your ChatGPT plan then run as `chatgpt/<model>`, for example `agency -p "..." --model chatgpt/gpt-5.5`. The login prints the models of your plan. Usage counts against the limits of the plan, and a turn costs nothing more; set a weekly limit for Agency at https://chatgpt.com/settings/usage. A run on the plan prints "Using ChatGPT plan".

This is the flow that OpenAI documents for open-source, locally hosted apps (developers.openai.com/siwc): the first sign-in registers Agency for your account and this computer, and later sign-ins reuse that registration. Agency checks the signature of the ID token, keeps the tokens in the OS keychain, and refreshes them before they end. `agency auth logout chatgpt` revokes the sign-in. Requests go to the Responses API with `store: false`, so OpenAI keeps no conversation; the encrypted reasoning of the model goes back with each request, as in Codex. When the plan limit is reached, the turn stops with a link to the settings.

Status: tested against a local server that follows the docs of OpenAI. No sign-in to a real ChatGPT account has run yet.

A Claude Pro or Max plan cannot be used: Anthropic does not permit third-party apps to offer a Claude sign-in ([Claude Code legal and compliance](https://code.claude.com/docs/en/legal-and-compliance)). Use an Anthropic API key, and `agency auth login anthropic --oauth` says so.

### OAuth (`provider.<id>.oauth`)

`agency auth login <provider> --oauth` runs the PKCE browser flow for `google` or `github-copilot` and stores the token in the OS keychain under the single canonical `<provider>:oauth` slot. The shipped client ids are placeholders: register an OAuth app at the provider's developer console and provision it via config:

```jsonc
{
  "provider": {
    "google": { "oauth": { "clientId": "your-client-id" } }
  }
}
```

Without a configured `clientId` the login and any token refresh fail with an explicit auth error (a failed refresh never silently reuses the stale token — re-run `auth login <provider> --oauth`). `baseUrl` optionally points the authorize/token endpoints at a self-hosted gateway (`<baseUrl>/authorize`, `<baseUrl>/token`).

Registration is a human step per provider; no shipped client id is functional and none is baked in:

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

The same rule applies to `.agency/plugins/`, `.agency/skills/`, `.agency/agents/` and `.agency/commands/` of the workspace. A plugin file is code that runs inside the daemon, an agent file can give its agent tools, and a command file can hold shell blocks, so the daemon loads them only for a trusted workspace. In an untrusted workspace the team is the roster from the config and the user config directory, and the daemon writes no default agent files. The `agentsMd` text of each loaded plugin is added after the project instructions. A skill with a `description` in its frontmatter loads on demand: the prompt holds one line with its name and description, and the model gets the body from the `skill` tool when a task needs it. A skill with no description cannot be chosen that way, so its full text is added to the prompt. Plugins, skills, agents and commands in the user config directory load in every workspace.

The user files of other agents load in every workspace, after those of the user config directory, which win on a name: the skills of `~/.claude/skills`, `~/.agents/skills`, `~/.codex/skills`, `~/.cursor/skills`, `~/.pi/agent/skills`, `~/.config/opencode/skills` and `~/.gemini/skills`; the commands of `~/.claude/commands`, `~/.cursor/commands`, `~/.codex/prompts`, `~/.pi/agent/prompts`, `~/.config/opencode/commands` and `~/.gemini/commands`; and the agent files of `~/.claude/agents`, `~/.cursor/agents`, `~/.codex/agents` and `~/.config/opencode/agents`. Their user hooks, code plugins and instruction files do not load: a hook runs a program, and an instruction file of one agent is often about that agent. With `"userAgentInstructions": true`, the user instruction files load before those of the workspace, in every workspace: `~/.claude/CLAUDE.md`, `~/.codex/AGENTS.md` (or `~/.codex/AGENTS.override.md` in its place, as Codex reads it), `~/.gemini/GEMINI.md`, `~/.config/opencode/AGENTS.md`, `~/.pi/agent/AGENTS.md` and the rules of `~/.claude/rules/`. A file with the text of another counts once. The files are read again on each turn. `AGENCY_AGENTS_HOME` gives another home folder for these files, and `AGENCY_AGENTS_HOME=off` reads none.

A trusted workspace also gives the files that other agents keep in it, so a project set up for one of them works here as it is:

- Instructions: `GEMINI.md` beside `AGENTS.md` (or an `AGENTS.override.md` in its place, as Codex reads it) and `CLAUDE.md`, with `.claude/CLAUDE.md` and the personal `CLAUDE.local.md` of Claude Code (nearest folder first), `.cursorrules`, `.windsurfrules`, `.clinerules` (a file, or a folder of `.md` files), `.roorules` and `.roo/rules/`, `.kilocode/rules/`, `.github/copilot-instructions.md`, `.junie/guidelines.md`, `.augment-guidelines`, `.rules` (Zed), `.trae/rules/project_rules.md`, the rules of Cursor in `.cursor/rules/**/*.mdc`, and those of Kiro (`.kiro/steering/`), Augment (`.augment/rules/`), Continue (`.continue/rules/`) and Windsurf (`.windsurf/rules/`). The rules of Kiro, Augment, Continue and Windsurf use the same mapping as those of Cursor, with `inclusion: always` and `fileMatchPattern` of Kiro, `type: always_apply` of Augment and `trigger: always_on` of Windsurf; `inclusion: manual`, `type: manual` and `trigger: manual` leave a rule out, and a rule with none of these keys applies always. A Cursor rule with `alwaysApply: true` is added as it is, one with `globs` gets the line `Files that match <globs>:`, and one with only a `description` gets `When the task is about: <description>`. A rule with none of these is one that Cursor adds only on `@name`, so it is left out. The files that `instructions` of `opencode.json` names (paths or globs, inside the workspace; a URL is not fetched) join as they are. The rules of Claude Code in `.claude/rules/**/*.md` join too: one with `paths` in its frontmatter (a list of globs, or one) gets the line `Files that match <paths>:`, and one with no `paths` applies always. An `@path` in a `CLAUDE.md` or `GEMINI.md` imports that file in its place, as in Claude Code and Gemini CLI, five levels deep; an import in a code block or a code span stays as it is, and so does a path that is not a file inside the workspace (a user file imports from the home folder only), so that a workspace cannot put a key of `~/.ssh` into the prompt. The `AGENTS.md`, `CLAUDE.md` and `GEMINI.md` of a subfolder join when a `read`, `edit`, `write` or `notebook_edit` call first reaches a file in that folder or below it: their text follows the result of that call, once in a session, as Claude Code loads a nested `CLAUDE.md`. The `.github/instructions/**/*.instructions.md` files of Copilot use the same mapping, with `applyTo` as the globs (`**` applies always); one with no `applyTo` and no `description` is left out, as Copilot adds it only on request. Two instruction files with the same text count once.
- Skills: the `skills/<name>/SKILL.md` folders of `.claude/`, `.agents/`, `.cursor/`, `.codex/`, `.pi/`, `.opencode/`, `.gemini/` and `.github/` (Copilot). `.agency/skills/` wins on a name.
- Commands: the Markdown commands of `.claude/commands/`, `.cursor/commands/`, `.opencode/commands/` and `.pi/prompts/`, and the TOML commands of Gemini CLI in `.gemini/commands/`. In a TOML command, `{{args}}` is `$ARGUMENTS`, `@{path}` adds the file, `!{command}` adds the output of the command, and a file in a subfolder is `/<folder>:<name>`. With no `{{args}}`, the words after the command go after the prompt, as in Gemini CLI. The prompt files of Copilot in `.github/prompts/*.prompt.md` are commands too (`/<name>`), and the words after the command go after the prompt. The `command` map of `opencode.json` gives a command for each `template`, with its `description`. `.agency/commands/` wins on a name.
- Agents: the agent files of `.claude/agents/`, `.cursor/agents/`, `.codex/agents/` and `.opencode/agents/`. Their keys that have no use here (`maxTurns` of Claude Code, `mode` of OpenCode, `is_background` of Cursor and others) are left out. `readonly: true` of Cursor gives the agent the read tools only, and a `model` of OpenCode such as `anthropic/claude-sonnet-5` sets the provider and the model. The custom agents of Copilot (`.github/agents/*.agent.md`, and the older `.github/chatmodes/*.chatmode.md`) load too: their tool sets map to tools here (`edit`, `search`, `read`, `runCommands` or `execute`, `fetch` or `web`, `todo`), an agent with only other tools (an MCP server of Copilot) gets the read tools, and the agent keeps the model of its parent, because a `model` of Copilot is a name for display. The `agent` map of `opencode.json` gives a subagent for each entry with a `prompt` (`{file:path}` reads a file inside the workspace), with its `description`, a `model` as `provider/model`, and a `tools` map whose `false` denies that tool (`write`, `edit`, `bash`, `webfetch` and others); a primary agent of OpenCode (`mode: "primary"`) is left out. `.agency/agents/` wins on a name.
- Code: the plugins of OpenCode in `.opencode/plugins/` (or `.opencode/plugin/`), and the extensions of Pi in `.pi/extensions/` (a module file, or a folder with `index.ts`). They run in the daemon as a plugin module does, through a shim of the API of their agent.
  - The npm plugins of the `plugin` key of `opencode.json` (or `opencode.jsonc`) load too, from where npm or OpenCode installed them: `.opencode/node_modules`, the `node_modules` of the workspace, then the cache of OpenCode (`~/.cache/opencode/node_modules`). Agency installs no package: a plugin that is in none of these places is named in the daemon log. The version of `name@1.2.0` is not checked.
  - With `"userAgentPlugins": true` in the config, the code of the user folders of OpenCode and Pi loads too, in every workspace: `~/.config/opencode/plugins/`, the npm plugins of `~/.config/opencode/opencode.json`, and `~/.pi/agent/extensions/`. It is off by default, because it is code that runs in the daemon.
  - An OpenCode plugin is each function that the file exports. It gets `directory`, `worktree`, `project` and `$` (the shell of Bun). Its hooks `tool.execute.before` (a throw blocks the call), `tool.execute.after`, `shell.env`, `event` and `permission.ask` run on the events here, and its `tool` map adds tools. Its `client` talks to an OpenCode server, so each call of it fails.
  - A Pi extension gets `pi`. `registerTool` adds a tool; `on` runs `tool_call` (`{ block: true, reason }` blocks), `tool_result`, `session_start`, `before_agent_start` and `agent_end`; `exec` runs a program. A command, a shortcut, a renderer and the other events do nothing. `ctx.hasUI` is false, and `ctx.ui.confirm` gives false.
  - Agency gives the imports `@opencode-ai/plugin` (`tool`, and `tool.schema`, which is zod), `typebox` and `@sinclair/typebox` (`Type`), and the Pi packages `pi-coding-agent` and `pi-ai` of `@earendil-works` or `@mariozechner` (`Type`, `StringEnum`). Another package that the code imports must be installed in its folder.
  - A tool of such a plugin has no risk tier, so it asks as an MCP tool does.

## Permissions

`permissions` maps a tool name (or `external_directory`) to a bare decision or a pattern map. Pattern maps use last-match-wins: e.g. `{"bash": {"*":"ask","git *":"allow","rm *":"deny"}}`. A shell command with more than one command in it (`;`, `&&`, `||`, `|`, `&`, a new line) is judged part by part, and the strictest verdict wins: a rule that allows `git status*` does not allow `git status; rm -rf build`. Each part is also judged in the forms that hide it: behind a wrapper (`sudo`, `env A=1`, `nohup`, `command`, `time`, `exec`, `nice`), behind a variable assignment, with a folder or `.exe` on the program, and inside `sh -c "..."`, `bash -c "..."`, `cmd /c "..."` or `powershell -Command "..."`. So a rule that denies `rm *` also denies `sudo rm -rf build` and `/bin/rm -rf build`. The same holds for a command in a group (`{ ...; }`), a subshell (`( ... )`), after `if`, `then`, `do`, `!`, in a `case` arm or a function body, and for the command that `eval`, `xargs` or `find -exec` runs. A command with a command substitution (`$(...)`, backticks, `<(...)`), a here-document, a here-string, a `$'...'` string, or a variable as its program (`$TOOL build`) is never allowed by a rule: it asks. A destructive command also asks in spite of a pattern rule that allows it: `rm -r`, `git push --force` (also `-f`, `--force-with-lease`, `+branch`), a remote branch delete (`git push --delete`, `-d`, `:branch`), `git reset --hard`, `git clean -f`, `git branch -D`, `git checkout` with `--`, `.` or `-f`, `git restore` of the working tree (not `--staged` alone), `git stash drop`, `git stash clear`, `find -delete`, `del /s`, `rd /s`, `Remove-Item -Recurse`, `dd`, `shred`, `mkfs`, `format`, `diskpart`. The bare decision `"bash": "allow"` and the `allow-all` mode still run such a command with no ask. An "always allow" answer for such a command covers that exact text only. Path patterns match workspace-relative forward-slash paths. The daemon builds a `PermissionsGate`; the sandbox enforces `external_directory` and a deny-only `CommandPolicy` derived from `bash` deny patterns. A tool with no entry runs when its risk tier is `safe` and asks otherwise; a tool with no risk tier (an MCP tool) asks.

Rules in the form of Claude Code work too: `Bash(git push *)` (or the older `Bash(npm run test:*)`), `Read`, `Edit(src/**)`, `WebFetch`, `mcp__<server>__<tool>`. A tool name of Claude Code, Cursor or Gemini CLI names the tool here (`Bash` is `bash`, `WebFetch` is `fetch`, `Task` is `spawn`). As in Claude Code, an `Edit` rule holds for each tool that edits files (`edit`, `write`, `notebook_edit`), and a bare `Read` rule for `grep` and `glob` too; a `Read(<path>)` rule holds for `read` only, because `grep` and `glob` take a folder. They come from two places:

- The `permissions` (`allow`, `ask`, `deny`) of `~/.claude/settings.json`, and in a trusted workspace those of `.claude/settings.json` and `.claude/settings.local.json`. As in Claude Code, a deny rule of any of these files wins. The `permissions` of the config come after them, so they win on a call. A rule with no counterpart here (a path outside the workspace, `WebFetch(domain:...)`, a whole MCP server as `mcp__github`) is named in the daemon log and left out.
- `--allowed-tools <rules>` and `--disallowed-tools <rules>` of `-p` (also spelled `--allowedTools` and `--disallowedTools`), with the rules split by commas: the tools run with no ask, or are denied, for that run only. They win over the config, and a denied rule wins over an allowed one. As in Claude Code, a denied `*` takes every tool away, and a denied `mcp__*` every MCP tool. A rule with no counterpart here stops the run with an error, so a deny never goes missing. `agency mcp serve` takes them too.
- `--tools <names>` of `-p`, as in Claude Code: the run has only these built-in tools (`Bash,Read,Edit`, by the names of Claude Code or of Agency). `--tools ""` gives no built-in tool, and `default` all of them. The tools of MCP servers stay. A tool that the list leaves out is not offered to the model, and an allow rule does not bring it back.

A headless run (`-p`) has no approval surface, so an ask refuses at once. `--permission-mode` sets how one run answers asks: `ask` (default) refuses, `allow-edits` allows `write` and `edit`, `allow-all` allows every tool, `deny` refuses every tool above `safe`. No mode overrides a `deny` entry, the `.env` read block or the trust gate.

`auto` is the auto mode of Claude Code: it allows `write` and `edit` as `allow-edits` does, and a reviewer model answers each other ask that comes from a default rule. An `ask` entry of `permissions` still goes to you. The reviewer is `auto_review_model`, else `small_model`, else `model`. It gets your messages, the tool calls of the agent and the action, but no tool result and no text of the agent, so text that the agent read cannot talk to it. It blocks an action that goes past your request or against a limit that you stated, destroys work, sends data to a place that you did not name, changes shared systems, or seems to come from read text. A blocked call gives the model the reason, and the `PermissionDenied` hooks run. After 3 blocks in a row or 20 in one turn, the next ask goes to you, as in Claude Code; so does an ask that the reviewer cannot answer (no model, a failed call, an answer that is not JSON). With `-p` such an ask refuses. Each review is one request to the model, which costs money. Workers of `spawn` and agents of `dispatch` have the reviewer of the run.

An agent of the team has its own `permissions` map in its roster entry. That map never gives the agent more than the run has. For each tool call the stricter verdict of the agent's map and the global `permissions` wins, and the mode of the run answers the asks. In the default mode a dispatched agent can only read. `--permission-mode allow-edits` lets it use `write` and `edit`, and `--permission-mode allow-all` or an `allow` entry in the global `permissions` lets it use the tools that its own map allows.

One turn takes at most 100 tool steps. A run that reaches the limit prints `iteration_limit` and exits with code 1. `maxSteps` in the config sets the limit for every turn, and `--max-steps <n>` sets it for one run.

`permissions.git_write` (`allow|ask|deny`, default `deny`) gates real git writes: Todo 8 materialization calls `assertGitWriteAllowed` (packages/guard/src/git-write.ts) before creating commits. `allow` proceeds, `ask` routes through the existing `approval_requested` / `approval_respond` RPC surface (`once`/`always` proceed, `reject`/timeout deny), `deny` refuses with typed `PERMISSION_DENIED`. Non-interactive runs always deny regardless of setting. Only bare decisions are read; pattern maps and unknown values fail closed to `deny`.

## Sandbox

Two backends, selected by `sandbox.backend` (`software`, the default, or `docker`):

- `software` runs commands in-process behind `SandboxBoundary` (path containment + command policy). No daemon, no probe, no added boot latency.
  It is a software boundary and not an isolation of the operating system: a shell command runs with your rights. A command of the `bash` tool, in the foreground or in the background, does not get the provider keys of the harness (`AGENCY_<ID>_API_KEY` and each variable that `provider.<id>.env` names), nor any variable with `KEY`, `SECRET` or `TOKEN` in its name, in any case: the default list of Codex. So `OPENROUTER_API_KEY`, `GITHUB_TOKEN` and `AWS_SECRET_ACCESS_KEY` stay out of reach of a command that would print them or send them out. Every other variable of your environment is there, as in your own shell. `sandbox.allowEnv` gives back the names that a command needs, for example `["GH_TOKEN"]`; `sandbox.denyEnv` removes more names. A name in either list can have `*` for any text, with no regard to case. `sandbox.denyEnv` wins over `sandbox.allowEnv`, and the `AGENCY_<ID>_API_KEY` keys never pass.
  A key that a tool result holds is replaced with `[REDACTED]` before the model, the hooks and the session get the result. This applies to the keys that the daemon knows: each `apiKey` of the config, the variables that `provider.<id>.env` names, each variable of the environment whose name ends in `_API_KEY`, and the key of the turn. It stops a key in the output of `env` or in a file that the model reads. It does not stop a command that sends such a variable to a server.
- `docker` runs commands across a volume mount via `DockerSandboxBackend`: `docker exec` against `sandbox.container` when set, otherwise one-shot `docker run --rm` with `sandbox.image` (defaults to `alpine`). Construction is side-effect free; no container is created and no daemon is contacted until exec/probe runs.

Fail-closed, never silent fallback: when `sandbox.backend` is `docker` but no daemon answers `docker info`, daemon boot throws a typed `AgencyError` (`internal`) telling the operator to start the Docker daemon or set `sandbox.backend` to `software` (`AGENCY_SANDBOX_BACKEND=software`). The check runs at boot — before any RPC is served — so a misconfigured daemon refuses to serve rather than running turns against an unintended backend. The command that started the daemon shows the reason at once. With the `docker` backend, `background: true` is refused: the command would run on the host. There is no code path that falls back to software: backend selection (`createSandboxBackend`) is a pure branch on config, and the boot gate (`ensureSandboxAvailable`) only probes container-backed backends (capability-checked, so software never pays for a probe).

Egress (deny-by-default once configured): `sandbox.egress` undefined means unrestricted (no `--network` flag, current behavior). A defined allowlist — even empty — isolates one-shot `docker run` with `--network=none`, unless `sandbox.network` names an explicit network (explicit intent wins, including without egress). Per-hostname enforcement is deliberately NOT at the container-flag level — plain `docker run` flags cannot express hostname allowlists — so the allowlist itself is enforced at tool-policy level (`requireNetwork` over `capabilities.network`, the same gate `fetch`/`browser`/`websearch` use); the `--network` flag is the coarse container-level lock. DNS-level filtering inside the container is out of reach and not claimed.

Capability drops: `sandbox.capDrop` entries map to `--cap-drop` flags on one-shot `docker run`, validated against the known-good Linux capability set (`capabilities(7)`); `CAP_`-prefixed and lowercase spellings canonicalize, unknown names throw a typed error at backend construction (daemon boot fails fast). Pinned-container caveat: `docker exec` cannot set network or capabilities — the container's network/caps are fixed at creation — so `egress`/`network`/`capDrop` apply to one-shot `docker run` only; operators pinning `sandbox.container` must configure that container's network and caps out of band.

## Review

`agency review` reviews the uncommitted changes of the workspace, new files included. `agency review <ref>` reviews the changes since a branch, a tag or a commit (`git diff <ref>...HEAD`). The model gets the diff, can read the files around it, and reports problems with file, line and a case that fails. The turn has the `ask` mode with no person to ask, so an edit or a shell command is refused and no file changes. `--model`, `--format json` and `--max-cost` work as with `-p`. A diff above 200000 characters is cut.

## Flags of other agents

A script written for `claude -p`, `codex exec` or `pi -p` runs with `agency` in their place:

- Claude Code: `-p` with the prompt after the flags (or from stdin when there is none), `--output-format`, `--max-turns` (as `--max-steps`), `--max-budget-usd` (as `--max-cost`), `--effort` (as `--thinking`; `ultracode` is `xhigh`), `--system-prompt-file`, `--append-system-prompt-file` (its text comes before that of `--append-system-prompt`), `-c`, `-r`/`--resume <id>` and `--session-id <id>` (as `--session`), `--fork-session` (the turn runs in a copy of that session, and the result names the copy), `--settings <file|json>` (its `permissions` `allow`, `ask`, `deny` and `defaultMode`, `model`, `fallbackModel` and `effortLevel`; a flag of the command wins, and the run names on stderr the keys it does not use, such as `hooks` and `env`), `--dangerously-skip-permissions` (as `allow-all`), and the modes of `--permission-mode`: `default`, `manual` and `dontAsk` are `ask`, `acceptEdits` is `allow-edits`, `bypassPermissions` is `allow-all`, and `plan` is `deny`, so no file changes. `--verbose` and `--include-partial-messages` change nothing: stream-json has every event. `--no-session-persistence` changes nothing either: a `-p` run without `--session` or `--continue` keeps no session. `--input-format` takes `text` only. The JSON result, and the last line of stream-json, start with the fields of the result of Claude Code: `type` (`result`), `subtype` (`success`, `error_max_turns` or `error_during_execution`), `is_error`, `result` (the answer), `num_turns`, and `session_id` and `total_cost_usd` when they are known. A run that fails before its turn prints such a result with `is_error` and the message too.
- `codex exec`: `agency exec <prompt>` runs as `-p`, `agency exec resume <id>|--last <prompt>` goes on in a session, and `agency exec fork <id> <prompt>` in a copy of it. `-C`/`--cd <dir>` (as `--workspace`), `-m` (as `--model`), `-i` (as `--image`), `--output-schema <file>` (as `--json-schema`), `-o`, `--json` (JSON lines of the events of Agency, not of Codex), and `--yolo` (as `allow-all`: the sandbox stays on). `--skip-git-repo-check` and `--ephemeral` change nothing: Agency needs no git repository, and a `-p` run without a session keeps none.
- Pi: `-c`, `--thinking`, `--tools`, `--no-tools`/`-nt` (no built-in tool and no MCP tool), `--exclude-tools`/`-xt` (as `--disallowed-tools`), `--fork <id>` (as `--session <id> --fork-session`), `--mode text|json` (json as stream-json, with the events of Agency), and `--no-session`, which changes nothing.

A prompt that starts with `-` goes in `-p=<prompt>` or after `--`.

## Worktree

`-p --worktree <name>` (or `-w <name>`) runs the turn in the git worktree `.agency/worktrees/<name>` of the repository, on the branch `agency/<name>`, as `claude --worktree` does. Agency makes the worktree from `HEAD` when it is missing, or from the branch when only the branch is there; a later run with the same name uses it again. The name has letters, digits, `_`, `.` and `-` only. `.agency/worktrees/.gitignore` keeps the worktrees out of `git status`. Sessions are those of the worktree, and the trust of the repository covers it. Agency does not remove a worktree: `git worktree remove` does.

## Structured answer

`--json-schema <file>` with `-p` makes the answer JSON that matches a JSON Schema. The value can also be the schema text. Stdout is the JSON only, and `--format json` has it as `structuredOutput`. The model gives the answer through a `structured_output` tool, and an answer that breaks the schema goes back to the model with the reason. The run exits with code 1 when the model gives no such answer. The check covers `type` (also a list of types), `enum`, `required`, `properties` and `items` at any depth. Other keywords (`pattern`, `minimum`, "oneOf", "$ref") are not checked. It is for a one-shot run, not for `--session`.

## System prompt

The system prompt of a turn is a base text, then the environment block, the project instructions and the list of skills. With `-p`, `--system-prompt <text>` replaces the base text for that run, and `--append-system-prompt <text>` adds text after it. Both are flags of Claude Code. The other parts stay.

## Reasoning effort

`--thinking <level>` with `-p` sets the reasoning effort of the model for that run, on the scale of Pi: `off`, `minimal`, `low`, `medium`, `high`, `xhigh` or `max`. Each provider maps it to its own setting. It wins over the `auto` effort of an agent of the config.

## Sandbox of the operating system

`sandbox.backend: "os"` runs each shell command of the model in a sandbox of the operating system: bubblewrap (`bwrap`) on Linux and Seatbelt (`sandbox-exec`) on macOS, the programs that Claude Code uses. A command can read the disk, can write only in the workspace and in a temporary folder, and has no network. In the workspace it cannot write `.git/hooks`, `.git/config` or `.agency` (but `.agency/worktrees`, where the agents of a team work), and cannot rename `.git`: the harness runs git and the hooks, MCP servers and plugins of `.agency` outside the sandbox later. It cannot read the data and config folders of Agency (keys, sessions, daemon tokens). `sandbox.allowNetwork: true` gives it the network. The daemon does not start when the sandbox program does not work, and it never falls back to no sandbox. A command in the background (`background: true`) runs in the same sandbox.

`sandbox.allowedDomains` gives a command only the hosts in the list, as the sandbox of Claude Code does: `"github.com"` is that host, and `"*.npmjs.org"` is each host under it (not `npmjs.org` itself). The daemon runs a proxy that passes only these hosts. The command reaches this proxy and nothing else, and `HTTP_PROXY`, `HTTPS_PROXY` and `ALL_PROXY` name it. curl uses it (tested); git, npm, pip and Bun read the same variables. A program that does not use a proxy gets no network. Another host gets the answer 403 with the reason. On macOS the profile allows only the port of the proxy. On Linux the command has its own network, and `socat` (`apt install socat`) relays the proxy into it, as in Claude Code; the daemon does not start without `socat`. `allowNetwork: true` wins over the list. Windows cannot do this without administrator rights, and the daemon does not start with the list there.

Status on Linux: run on Ubuntu 26.04 in WSL 2 with bubblewrap 0.11.1 and socat 1.8.1. A write outside the workspace and a direct connection were denied; with `allowedDomains`, curl reached a host of the list and got 403 for another. The same test runs on macOS in CI.

On Windows the backend starts each command under a write-restricted token, through a small helper process (the hidden command `__sandbox` of the binary). The token holds an own SID for each workspace. At the start of the daemon, the workspace and a temporary folder of the workspace (in the temporary folder of the user) get an access rule that lets this SID write, and `.git\hooks`, `.git\config` and each entry of `.agency` but `worktrees` get a rule that denies writes; `.agency` takes no new entry. The rules stay on the folders; an entry that the daemon adds to `.agency` gets its rule at the next start. A command can then write only in these two folders, and in a folder that gives write access to `Everyone` (the NUL device needs this). `TEMP` and `TMP` of the command name the temporary folder of the workspace. A job object ends all processes of the command when it is cancelled or times out. Limits:

- Windows cannot keep a command off the network without administrator rights. The daemon does not start until `sandbox.allowNetwork` is `true`.
- Git Bash (MSYS) does not start under such a token: its shared memory refuses the token. The backend uses PowerShell when `windowsShell` has no value, and the daemon does not start with `windowsShell: "gitbash"`. Programs of Git Bash (`sed`, `awk` from `Git\usr\bin`) also do not start; `git` itself works.
- A command reads what the user can read, also the keys that `agency auth login` saved: DPAPI decrypts them for any process of the user (measured with a test key).
- The token restricts writes, not delete and rename: a command can delete or rename what the user can, in the workspace (also `.git` and its hooks) and outside it (measured: a file outside the workspace was deleted).
- Each command takes about 150 ms more: the helper loads the binary.

Measured on Windows 11: PowerShell, `cmd`, `git`, Bun and Python run; a write outside the workspace, in `.git\hooks`, in `.git\config` and a new entry in `.agency` are denied; `git add` and `git commit` work; a timeout ends a child process of the command.

## Long runs

- **Step limit.** `maxSteps` in the config, or `--max-steps <n>` for one run. It is a guard against a model that never stops. A spawned worker has the default of 100.
- **Cost limit.** `--max-cost <usd>` stops the turn when its cost reaches the amount. The run prints `budget_exceeded` and exits with code 1. The cost is the provider's own charge when it reports one (OpenRouter), and the price table of the model if not. A model with no price never reaches the limit. `budgets.dailyUsd` and `budgets.monthlyUsd` in the config are limits for the daemon as a whole.
- **Fallback model.** When the model stays overloaded, rate limited or down after its retries, the turn goes on with `fallback_model` of the config, or with `--fallback-model <provider/model>` for one run, as in Claude Code. It can be another model of the same provider. Of a comma list, as Claude Code takes, Agency uses the first model. The fallback needs a key of its own provider: the key of the turn never goes to another provider.
- **Goal.** `--goal` keeps a turn going until a condition is met (see Session goal).
- **Events for a script.** `--format stream-json` with `-p` prints one JSON line for each event of the turn (`text_delta`, `tool_start`, `tool_result`, `turn_complete`, `retry` and the others), and then the result as the last line, with `"type": "result"`.
- **Answer in a file.** `-o <file>` (`--output-last-message`, as in `codex exec`) writes the answer to the file too, whatever the format of stdout. With `--json-schema`, the file gets the JSON.
- **See and stop a run from another terminal.** `agency daemon status` lists the turns that run in the daemon of the workspace: the id of each turn, its session, its model and its start time. `agency daemon cancel <turn>` stops one. The run that started the turn then ends as a cancelled turn.
- **Continue.** A turn that reached a limit keeps its steps in the session. `--continue` or `--session <id>` goes on from there.
- **Request rate.** The daemon paces the requests to one provider, for all turns and workers together, at the rate of its API: `anthropic` 60 a minute, `openai` 500, `google`, `groq` and `xai` 300, `openrouter`, `deepseek` and `glm` 200, any other provider 60. `provider.<id>.requestsPerMinute` sets another rate. Several workers at one time on a fast model reach it.

## Workflows

`agency workflow run <file>` runs a script that starts agent turns. Use it when the order of the work is fixed and you do not want the model to decide it: the script is the plan, and each agent does one part. The file is a JavaScript or TypeScript module whose default export is a function:

```js
export default async ({ agent, parallel, args, log }) => {
  const files = (await agent(`List the source files of ${args.dir}, one for each line.`)).text.split("\n");
  const reviews = await parallel(files.map((file) => () => agent(`Review ${file} for bugs.`)), 3);
  log(`${reviews.filter((r) => r.ok).length} reviews done`);
  const notes = reviews.map((r) => r.text).join("\n");
  return (await agent(`Write one report from these reviews:\n${notes}`)).text;
};
```

- `agent(prompt, options)` runs one turn with a new context, as `-p` does, and gives `{ text, stopReason, usage, ok }`. `ok` is false when the turn ended with an error, at the step limit or at the cost limit. `options` can set `model` (`provider/model`), `permissionMode`, `maxSteps` and `maxCost` for that turn. With no option, the turn has the `--model`, `--permission-mode`, `--max-steps` and `--max-cost` of the command line.
- `parallel(tasks, limit)` runs functions at the same time, at most `limit` at one time (4 with no value), and gives their results in the order of the tasks.
- `args` holds the `--arg key=value` pairs of the command line. `log(text)` prints a line on stderr.
- The value that the function returns is the output: a string as it is, and another value as JSON. An error of the script ends the command with exit code 1.
- `--max-cost` is a limit for each turn. `--max-total-cost <usd>` is a limit for the workflow: a turn gets the smaller of `--max-cost` and what is left of the total, and when nothing is left `agent()` starts no turn and gives `ok: false` with the stop reason `total_cost_limit`. Turns in parallel each get what is left at their start, so together they can go over the total. The limit counts `costUsd`, which a result has only when the provider reports its charge.

The script is your code. It runs in the `agency` process with your rights, and it needs no trust of the workspace. An agent of a workflow has the permissions of a `-p` run.

## Subagents

The `spawn` tool starts a worker: a child session that sees only the task that the model writes for it, and returns only its final text. Several `spawn` calls in one reply run at the same time. A worker cannot start another worker. In a trusted workspace a worker gets the project instructions (`AGENTS.md`, `CLAUDE.md`, the rules) in its system prompt, as the main turn does. It does not get the texts of plugins and skills.

An agent file with a `description` is an agent type of `spawn`. The tool lists each type with its description, and the model chooses one with the `agent` parameter. The worker then gets the body of the file as its system prompt, the `tools` of the file as its tool list, and the `provider` and `model` of the file when they are set.

```markdown
---
description: Reviews a diff for defects. Use after a code change.
tools: read, grep, glob
---
You review the diff that the task names. Report each defect with its file and line.
```

Agent files are in `agents/` of the user config directory, and in `.agency/agents/` of a trusted workspace. The file name is the name of the type. An agent file of Claude Code works as it is: `name` and `color` are accepted, its tool names (`Read`, `Bash`, `WebFetch` and the others) are mapped, and a `model` of `inherit`, `sonnet`, `opus` or `haiku` means the model of the parent turn.

A worker has the permission mode of the run that started it. In the default mode it can read, and an ask goes to the approval surface of the parent turn, so a headless run refuses it. In `allow-edits` it can change files, and in `allow-all` it can use the shell.

## Session goal

A session can hold a goal: a condition that must be true before a turn ends. When the model ends a turn, the daemon asks the model of that turn if the newest part of the transcript shows that the goal is met. If it does not, the model gets the reason as a message and the turn goes on. When the goal is met, the daemon clears it.

- `agency -p "<prompt>" --session <id> --goal "<condition>"` sets the goal for a headless run. `--goal` needs `--session` or `--continue`.
- `/goal <session> <condition>` sets it, `/goal <session> clear` removes it, and `/goal <session>` shows it. The `session_send` RPC takes it as `goal`.
- The step limit still applies (`--max-steps`, 25 by default). A turn that reaches it ends with the goal in place, and the next turn of the session checks it again.
- Each check is one more request to the model. It is not in the usage numbers of the turn.
- A check that fails, or a reply that is not a verdict, does not hold the turn.

The team report that `/goal` showed before is now `/report [outcome]`.

## Notebooks

`read` shows a Jupyter notebook (`.ipynb`) as its cells, each with its number, type and id, its source and the text of its outputs (an image output is named only), as Claude Code does. A read with `offset` or `limit` gives the raw JSON. `notebook_edit` changes one cell: `replace` (the default) sets the source and clears the outputs of a code cell, `insert` adds a cell after the given cell (or at the start), `delete` removes it. A cell is named by its id or its number. `notebook_edit` is an edit tool for the permission modes and the rules (`NotebookEdit` of Claude Code names it), and the `undo` of the daemon takes its changes back, as for `write` and `edit`.

## Output styles

`"outputStyle": "<name>"` adds an output style to the instructions of each turn, as the output styles of Claude Code do. A style is a Markdown file whose `name` (in its frontmatter, else the file name) is the name, and whose text says how to write the replies. Agency looks in `.agency/output-styles/` and `.claude/output-styles/` of a trusted workspace, then `output-styles/` of the config folder, then `~/.claude/output-styles/`. `agency plugin install` puts the styles of a plugin in `.agency/output-styles/`. The style joins the instructions and does not take the place of the base prompt, also with `keep-coding-instructions: false`. The value `default` adds nothing. A name that is not found is named in the daemon log.

## Memory

The `memory` tool keeps notes for the later sessions of a workspace, as the auto memory of Claude Code does. The model adds a note (one line), removes the notes that contain a text, or shows them. The notes are in `memory/<workspace id>.md` of the data folder of Agency (outside the repository, readable only by you), and each turn has them at the end of its instructions, with the warning that a note can be out of date. The file holds at most 200 notes of at most 1,000 characters; you can edit it by hand. `"memory": false` in the config removes the tool and the notes from the prompt.

The tool asks the model not to save a secret, the task in progress, or a note that a file or a web page asks it to save: a note is text that later sessions trust as their own.

## Compaction

A session is compacted when its history reaches 90 percent of the model's context window or `compactionLimit` tokens, the smaller of the two. The check runs before each turn and before each request in a turn, with the size that the provider reported for the last request. A compaction also runs when the provider reports a context overflow. Each request sends the whole history again, so a large window that fills costs much more than the work in it: this is the reason for the token limit. The older messages become one summary, and the newest messages stay as they are: at least the last four, and more up to 40 percent of the size after compaction, at most 40000 tokens. Task lists always stay. In a turn, the size of the system prompt and the tool list is taken out of the limit and of the size after compaction, because each request holds them too.

The model is told the limits of its turn in the result of a tool call, one time each: when 5 tool steps are left (for a step limit of 10 or more), and when 80 percent of the cost limit of the turn is spent.

Before a summary, the old tool output is removed: each old result becomes one line that gives its size, and the newest results stay, up to 35 percent of the window. No model writes this, and your messages, the model's texts and the tool inputs stay word for word. If this brings the history to 70 percent of the window, there is no summary. `/compact` always writes the summary.

The model of the session writes the summary: one more request, on the transcript of the older messages with long tool results cut short. The summary has fixed sections: the user's requests and rules, decisions, files read and changed, commands and results, errors and fixes, the state of the work, and the next step. If that request fails, or no key resolves for the provider, the daemon uses an offline summary that keeps only the first and the last lines of the transcript.

`/compact <session> [provider/model] [instructions]` compacts a session at any size. A first word of the form provider/model is the model that writes the summary. All other words are instructions for this one summary, for example `/compact s1 keep every file name`. They go after `compactionInstructions` of the config.

The summary ends with the messages that you wrote in the folded part, word for word, under `[the user's messages, word for word]`. A model can lose or change a rule when it writes a summary, and these lines cannot change. They also go on through later compactions. The newest lines are kept first, up to 10 percent of the size target and at most 20000 tokens, and one message is cut at 4000 characters.

## Hooks

`hooks` holds shell commands, HTTP requests and questions to a model that run on agent events. The format is the hook format of Claude Code settings, so a hook block from a Claude Code `settings.json` works here without changes.

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
| `PostToolUse` | After each tool call that succeeded | The reason is added to the tool result. |
| `PostToolUseFailure` | After each tool call that failed | The reason is added to the tool result. |
| `PostToolBatch` | Once after all tool calls of one reply, before the next request. The input has `tool_calls`: `tool_name`, `tool_input`, `tool_use_id` and `tool_response` of each call. There is no matcher | The turn ends with the reason, and the model gets no more requests. `additionalContext` is added once, to the last tool result. |
| `UserPromptSubmit` | Before the model sees a prompt | The turn fails with the reason, and the prompt is removed from the session. |
| `UserPromptExpansion` | When a typed command (`/name args` of a command file, or an MCP prompt) became the prompt. The input has `expansion_type`, `command_name`, `command_args`, `command_source` and the typed `prompt` | The turn fails with the reason, and the prompt is removed from the session. |
| `SessionStart` | Before the first prompt of a session | None. |
| `Stop` | When the model ends its turn | The turn goes on. The model gets the reason as a message. |
| `StopFailure` | When a turn ends on a provider error. The input has `error` (`authentication_failed`, `rate_limit`, `overloaded`, `server_error` or `unknown`), `error_details` and `last_assistant_message` | None. The error does not wait for the hook. |
| `SubagentStart` | When `spawn` or `dispatch` starts a worker | None. |
| `SubagentStop` | When a worker ends its turn | The worker goes on. It gets the reason as a message. |
| `PreCompact` | Before a compaction of a session | The session is not compacted. |
| `PostCompact` | After a compaction of a session | None. |
| `SessionEnd` | When a session is deleted. The input has `reason`, always `other` | None. |
| `Notification` | When a turn waits for your answer to an approval | None. |
| `PermissionRequest` | When a tool call needs an approval, before you are asked | The call is refused, and you are not asked. |
| `PermissionDenied` | When the reviewer of auto mode blocks a tool call. The input has `tool_name`, `tool_input`, `tool_use_id` and `reason` | None: the call is already refused. `hookSpecificOutput.retry: true` tells the model that it may retry the call. |

Each command gets the event as JSON on stdin: `hook_event_name`, `cwd`, `session_id`, and the fields of the event (`tool_name`, `tool_input`, `tool_use_id`, `tool_response`, `tool_calls`, `reason`, `error`, `prompt`, `stop_hook_active`, `last_assistant_message`, `agent_type`, `trigger`, `notification_type`, `message`). `CLAUDE_PROJECT_DIR` and `AGENCY_PROJECT_DIR` hold the workspace path. The command runs in the workspace, in the shell of the `bash` tool: `sh` on Linux and macOS, and the shell of `windowsShell` on Windows (Git Bash when it is installed). A hook that is a shell script thus runs on Windows too.

- Exit code 2 is a block, and stderr is the reason. So is exit code 0 with `{"decision": "block", "reason": "..."}` on stdout, or with `hookSpecificOutput.permissionDecision` set to `deny`.
- Any other exit code that is not 0 is a failed hook. It does not block.
- A `PermissionRequest` command can also approve: exit code 0 with `hookSpecificOutput.decision.behavior` set to `allow` on stdout runs the call, and you are not asked. `deny` refuses it. With no answer, the ask goes to you as before. A deny wins over an allow. The hook also runs in a run with no person to ask (`-p`), so a script can approve there. It does not run for a call that a rule or the permission mode already allows or denies.
- Stdout of a `UserPromptSubmit` or `SessionStart` command is given to the model as context and stays in the session. `hookSpecificOutput.additionalContext` does the same.
- A `SessionStart` command gets `CLAUDE_ENV_FILE`, as in Claude Code: the `export NAME=value` (and `declare -x`) lines that it appends there become variables of each later shell command of the session, with `$NAME` taken from the environment and the lines before. Claude Code runs the file as shell code before each command; here a line that is not an assignment, such as `source` or `nvm use`, is skipped. Each start of the session empties the file first.
- `matcher` is a regular expression on the tool name, with no regard to case, so `Bash` matches the `bash` tool and `Edit|Write` matches `edit` and `write`. With no matcher, the commands run for every tool. For the events that are not tool events, the matcher tests another value: the agent type for `SubagentStart` and `SubagentStop`, `manual` or `auto` for `PreCompact` and `PostCompact`, `permission_prompt` for `Notification`, the command name for `UserPromptExpansion`, and the error type for `StopFailure`. `SubagentStop` gets the agent type that its worker had at the start.
- A matcher or an `if` rule can name a tool by its name in another agent: `Shell` and `run_shell_command` are `bash`, `WebFetch` is `fetch`, `MultiEdit`, `replace` and `apply_patch` are `edit`, `read_file` is `read`, `write_file` is `write`, `Task` is `spawn`, and so on.
- `timeout` is in seconds. The default is 60. A command that runs longer is stopped, and it does not block.
- `if` is one permission rule on the tool call, as in Claude Code: `"if": "Bash(git push *)"` runs the command only for a `bash` call with such a command in it (also behind `&&`, `sudo` or `sh -c`), and `"if": "Edit(*.ts)"` only for an edit of a TypeScript file. A path pattern with no slash matches a file name at any depth; one with a slash starts at the workspace. A command line with `$(...)` or a here-document runs the hook, because the rule cannot read it. `if` counts on the tool events only (`PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `PermissionRequest`, `PermissionDenied`). On another event, a hook with `if` never runs.
- `"type": "http"` sends the event as a JSON POST to `url`, with the `headers` of the hook. A header value can name an environment variable as `$NAME` or `${NAME}` only when `allowedEnvVars` lists it; another name becomes empty. A 2xx answer with a JSON object works as the JSON on the stdout of a command, so `{"decision": "block", "reason": "..."}` blocks. Another status, a body that is not JSON, no connection or the timeout is a failed hook, which does not block. As in Claude Code, a status alone cannot block.
- `"type": "prompt"` asks a model about the event: `prompt` is the question, and `$ARGUMENTS` in it becomes the event as JSON (with no `$ARGUMENTS`, the event goes after the question). The model is `model` of the hook, else `small_model`, else `model` of the config. It must answer `{"ok": true}` or `{"ok": false, "reason": "..."}`; `ok: false` blocks with the reason. As in Claude Code, `ok: false` has no effect on `PermissionRequest`, a `Stop` or `SubagentStop` answer with `"impossible": true` lets the turn end, and a prompt hook runs only on the tool, prompt and stop events and `PostToolBatch`. Another answer, or a failed call, does not block. The default timeout is 30 seconds. Each run is one request to the model, which costs money. A `Stop` hook gets the text of the last reply as `last_assistant_message`.
- `"type": "agent"` gives the question of `prompt` to an agent that can use `read`, `grep` and `glob` of the session for at most 50 steps, then answers as a prompt hook does. It runs on the events of a prompt hook except `PermissionRequest`, and it has no `impossible`. The default timeout is 60 seconds. Each step is a request to the model.
- `"type": "mcp_tool"` calls the tool `tool` of the MCP server `server` of the session, with the arguments of `input`. `${path}` in a string of `input` becomes that value of the event, as `"${tool_input.path}"`. The text of the tool counts as the stdout of a command: a JSON answer blocks or adds context. A tool error, or a server that is not there, does not block. The name `plugin:<plugin>:<server>` of Claude Code names the server of an installed plugin.
- `async: true` or `asyncRewake: true` runs the command in the background: the event does not wait for it, and it cannot block. `async` has no time limit unless it sets `timeout`. When it ends, its `additionalContext` and `systemMessage` (JSON alone on stdout, or on a line of its own) reach the model before its next request, in this turn or the next one. On exit code 2, an `asyncRewake` hook gives the model its stderr (or stdout). Claude Code also wakes an idle session for it; here the text waits for the next turn.
- `Stop` hooks do not run for subagents: `SubagentStop` hooks do. A `Stop` hook that always blocks keeps the turn going until the step limit, so let it pass when `stop_hook_active` is true or when its condition is met.
- Claude Code has 33 events, and the 17 in the table run here (`InstructionsLoaded`, `CwdChanged` and others do not). A hook on an event that is not in the table does not run, and `agency plugin install` names each such event.

In a trusted workspace, the `env` of `.claude/settings.json` and `.claude/settings.local.json` (the local file wins on a name) reaches each shell command of the `bash` tool, as Claude Code sets it for each session. The variables of a `CLAUDE_ENV_FILE` come after it. Hook commands and MCP servers do not get it.

A trusted workspace also runs the hooks that other agents keep in it, after those of the config and of `.agency/hooks/`. The daemon log names each hook that it skips.

- `hooks` of `.claude/settings.json` and `.claude/settings.local.json` (Claude Code), and of `.codex/hooks.json` (Codex, which has the format of Claude Code).
- `.cursor/hooks.json` of Cursor. Its events map to those here: `beforeShellExecution` and `afterShellExecution` to `PreToolUse` and `PostToolUse` of `bash`, `beforeReadFile` to `PreToolUse` of `read`, `afterFileEdit` to `PostToolUse` of `write` and `edit`, `beforeSubmitPrompt` to `UserPromptSubmit`, `stop` to `Stop`, and the others to the event of the same name. A command hook of Cursor gets its own input (`command`, `file_path`, `conversation_id`, `workspace_roots`, beside the fields here), and its answer counts as in Cursor: `permission: "deny"` and `continue: false` block with `agent_message` or `user_message`, `followup_message` of a stop hook makes the agent go on with that text, `additional_context` is added, and `failClosed: true` makes a failed hook block. The `matcher` of a shell hook tests the command line. A prompt hook of Cursor is a prompt hook here. `beforeMCPExecution`, `afterAgentResponse` and the Tab events do not run.
- `hooks` of `.gemini/settings.json` (Gemini CLI): `BeforeTool` and `AfterTool` are `PreToolUse` and `PostToolUse`, `BeforeAgent` is `UserPromptSubmit`, `AfterAgent` is `Stop`, `PreCompress` is `PreCompact`, and `SessionStart`, `SessionEnd` and `Notification` keep their names. Its timeout in milliseconds becomes seconds, and an answer `{"decision": "deny"}` blocks.

The hooks of a Cursor plugin and of a Gemini extension are converted in the same way when `agency plugin install` installs them.

Hooks come from two places, and the daemon runs those of the user config first:

- `hooks` in the user config. The `.agency/config.jsonc` of a workspace cannot add hooks.
- Each `*.json` file in `.agency/hooks/` of the workspace, with the same format (the block can be the file, or the value of a `hooks` key). The daemon reads these files only when the workspace is trusted, because a hook command runs with your rights. A file that is not valid is skipped with a warning in the daemon log.

A plugin module can do the same from code: a handler of `tool.execute.before`, `tool.execute.after` or `turn.stop` that returns `{ block: "reason" }` blocks in the same way.

### Plugins of other agents

`agency plugin install <source>` takes a plugin of Claude Code (`.claude-plugin/plugin.json`), Codex (`.codex-plugin/plugin.json`, or the portable `plugin.json` at the root), Cursor (`.cursor-plugin/plugin.json`), a Gemini CLI extension (`gemini-extension.json`) or a Pi package (a `package.json` with a `pi` key or the keyword `pi-package`). The first manifest found in that order sets the format. The plugin name of a Pi package is its npm name with no scope.

- Skills come from `skills/`, or from the folders that the `skills` key of the manifest names (the `pi.skills` key of a Pi package). A plugin with no skills folder and a `SKILL.md` at its root is one skill, with the name of the plugin.
- Commands come from `commands/` (`.md`, `.mdc`, `.markdown`, `.txt`), or from the folders of the `commands` key; a `commands` key that maps names to `content` or to a `source` file gives a command for each name; the prompts of a Pi package (`pi.prompts`, default `prompts/`) are commands too. The TOML commands of a Gemini extension are converted as those of `.gemini/commands/`, and `gcs/sync.toml` becomes `/gcs-sync`, because a file name on Windows cannot hold `:`.
- Agent files are written in the form of an agent file here: their keys that have no use here are left out, as for the agent folders of other agents above.
- The rules of a Cursor plugin (`rules/`) go to `.agency/rules/<plugin>-<rule>.md`, with the mapping of `alwaysApply`, `globs` and `description` above. The context file of a Gemini extension (`contextFileName`, default `GEMINI.md`) goes to `.agency/rules/<plugin>.md`. Both join the instructions of a trusted workspace.
- MCP servers come from `.mcp.json`, `mcp.json` or the `mcpServers` key of the manifest. `httpUrl` of Gemini is `url`, and `${env:VAR}` of Cursor is `${VAR}`. `${CLAUDE_PLUGIN_ROOT}`, `${CURSOR_PLUGIN_ROOT}`, `${PLUGIN_ROOT}` and `${extensionPath}` become the folder of the installed plugin, and `${/}` becomes `/`.
- The `bin/` folder of a plugin is on the `PATH` of each shell command while the plugin is installed, as in Claude Code.
- The LSP servers of a Claude Code plugin (`.lsp.json`, and the `lspServers` key of the manifest, which wins on a name) go to `.agency/lsp/<plugin>.json` in the form of `lspServers`: the extensions of `extensionToLanguage` are `extensions`, and its first language is `languageId`. A trusted workspace loads them; a server of `lspServers` of the config wins on a name.
- `${CLAUDE_PLUGIN_DATA}` becomes `.agency/plugin-data/<plugin>/`, a folder that a new install of the plugin keeps. A hook command gets `CLAUDE_PLUGIN_ROOT` and `CLAUDE_PLUGIN_DATA` in its environment too.
- The `userConfig` of a Claude Code plugin is not asked for: `${user_config.KEY}` becomes `${CLAUDE_PLUGIN_OPTION_KEY}`, a variable of the environment that you set before the daemon starts. The install names each variable. The output styles of a plugin (`output-styles/`) go to `.agency/output-styles/`. Themes, monitors, workflows and `settings.json` of a plugin are named as not installed.
- The extensions of a Pi package (`pi.extensions`, default `extensions/`) stay in the copy of the package, and `.agency/plugins/<plugin>.ts` imports them. They run as the Pi extensions of a workspace do, below.
- A repository can be a marketplace of Claude Code (`.claude-plugin/marketplace.json`), Cursor (`.cursor-plugin/marketplace.json`) or Codex (`.agents/plugins/marketplace.json`).

The hooks of a plugin install with its other parts:

- The command, http, prompt, agent and MCP tool hooks of the events in the table above go to `.agency/hooks/<plugin>.json`. The install prints each event that it installed, and each event that it skipped with the reason (an event that does not exist here, or an entry of another type).
- The files of the plugin are copied to `.agency/plugin-roots/<plugin>/`, and `${CLAUDE_PLUGIN_ROOT}` in a command becomes that folder. The source folder can thus go away.
- A skill is copied with all the files of its folder, so a skill can name its own references and scripts.
- A plugin name or a skill name must be one plain name (letters, digits, `.`, `_`, `-`). A name that is a path is refused.
- `agency plugin remove <plugin>` deletes the hook file, the LSP file, the copied folder and the data folder with the rest of the plugin.
- `agency plugin update <plugin>` installs the plugin again from the source of its install (a folder, a git URL or `owner/repo`, and the marketplace entry), which its receipt keeps. The files of the old version go first, so a file that the new version lost goes too; the data folder stays. A plugin installed before the receipt kept its source needs `agency plugin install <source> --overwrite` once.
- The MCP servers of the plugin (its `.mcp.json`, or the `mcpServers` key of its manifest) go to `.agency/mcp/<plugin>.json`, with `${CLAUDE_PLUGIN_ROOT}` as the copied folder. `agency plugin remove` deletes that file too.

The source can also be a git repository: a URL (`https://`, `ssh://`, `git@host:path`, `file://`) or `owner/repo` of GitHub, with `#ref` for a branch or a tag. The install makes a shallow clone with `git`, installs from it, and deletes it. A repository with `.claude-plugin/marketplace.json` and no plugin manifest of its own is a marketplace, as in Claude Code: `agency plugin install owner/repo <plugin>` installs the plugin of that name, and the name is needed when the marketplace has more than one. A plugin source in the marketplace can be a folder in it (with `metadata.pluginRoot`), `{"source": "github", "repo": "owner/repo"}`, `{"source": "url", "url": "..."}` or `{"source": "git-subdir", "url": "...", "path": "tools/plugin"}` (a folder of another repository; `url` is a git URL or `owner/repo`), each with an optional `ref`. A folder source that goes outside the marketplace or the repository is refused.

`agency plugin install <plugin>@<marketplace>` takes the name of a plugin as Claude Code writes it. The marketplace comes from `extraKnownMarketplaces` (or `additionalMarketplaces`) of `.claude/settings.local.json`, `.claude/settings.json` and `~/.claude/settings.json`, in that order, then from the marketplaces that Claude Code added (`~/.claude/plugins/known_marketplaces.json`, whose local copy goes first), and `claude-plugins-official` is `anthropics/claude-plugins-official`. A marketplace source can be `github` (`repo`), `git` (`url`), each with `ref`, or `directory` (`path`); one in a subfolder of a repository (`path` with `github` or `git`), a `url` source and a `file` source are refused. `agency plugin sync` installs each plugin that `enabledPlugins` of `.claude/settings.json` and `.claude/settings.local.json` sets to `true`, so that a team that names its plugins for Claude Code gets them here with one command. A plugin with a receipt is left as it is, unless `--overwrite` is given. The command ends with code 1 when a plugin could not be installed, and names the reason for each.

## MCP / LSP

Configured under `mcpServers` / `lspServers`. The MCP layer accepts stdio (`command`+`args`) and HTTP (`url`) servers, optional `headers`, and per-request timeouts. LSP is a minimal client that decorates read/write/edit results with diagnostics. Failures surface via `providers_list` / `mcp_status` / `lsp_status` RPC and per-turn `mcp_server_down` system reminders.

An HTTP server that needs a sign-in (OAuth, as the MCP authorization spec has it) fails at the start of a session with the reason `MCP server "<name>" needs a sign-in: run `agency mcp login <name>``. `agency mcp login <name>` finds the authorization server of the server (from its 401 or its well-known metadata), registers Agency there as a client, opens the browser for the sign-in with PKCE, and keeps the tokens in the OS keychain. A new session then sends the token, and refreshes it a minute before it ends, or once when the server refuses it. `agency mcp logout <name>` removes the tokens. An `Authorization` header in `headers` wins over a sign-in. A server whose authorization server takes no client registration has no sign-in here: it needs a key in `headers`. Tested against a local server only: no sign-in to a real MCP server has run.

MCP servers come from these places, the first winning on a name:

- `mcpServers` in the user config.
- Each `*.json` file in `mcp/` of the user config directory, which `agency mcp import <client>` and `agency mcp add` write.
- `.mcp.json` in the workspace root, the project file of Claude Code: `{ "mcpServers": { "name": { "command": "...", "args": [...] } } }`. The `type` key of Claude Code is accepted and not needed: an entry with `command` is a stdio server, and an entry with `url` is an HTTP server.
- The project files of other clients, in this order: `.zed/settings.json` (`context_servers`), `.pi/mcp.json` (Pi), `.codex/config.toml` (`[mcp_servers.<name>]` of Codex), `opencode.json` or `opencode.jsonc` (`mcp`), `.gemini/settings.json` (`mcpServers`), `.cursor/mcp.json`, `.vscode/mcp.json` (`servers`), `.kiro/settings/mcp.json`, `.qwen/settings.json` (Qwen Code), `.crush.json` or `crush.json` (`mcp` of Crush, whose `$VAR` is `${VAR}`), `.amp/settings.json` (`amp.mcpServers`), `.github/mcp.json` (Copilot CLI), `.kilocode/mcp.json` and `.roo/mcp.json`. A server with `disabled: true` is left out too. Their keys become those of `mcpServers`: `httpUrl` of Gemini and `serverUrl` of Windsurf are `url`, the command array of OpenCode is `command` and `args`, `bearer_token_env_var` and `env_http_headers` of Codex are headers, and `${env:VAR}`, `{env:VAR}`, `${workspaceFolder}` and `${userHome}` are the values. A server with `enabled: false` is left out. A server of VS Code that needs an `${input:...}` is left out with a warning, because Agency cannot ask for it.
- Each `*.json` file in `.agency/mcp/`, which `agency plugin install` writes for a plugin.

The daemon reads the workspace sources only when the workspace is trusted, because a stdio server is a program that runs with your rights.

`agency mcp import <client>` copies the MCP servers of the user file of another client to `mcp/<client>.json` of the user config directory, with its variables kept as `${VAR}`: `claude` (`~/.claude.json`), `claude-desktop`, `cursor` (`~/.cursor/mcp.json`), `codex` (`~/.codex/config.toml`, or `$CODEX_HOME`), `gemini` (`~/.gemini/settings.json`), `kiro` (`~/.kiro/settings/mcp.json`), `opencode` (`~/.config/opencode/opencode.json`), `pi` (`~/.pi/agent/mcp.json`), `vscode` (the `mcp.json` of the user profile), `windsurf`, `zed`, `copilot` (`~/.copilot/mcp-config.json` of Copilot CLI), `amp` (`~/.config/amp/settings.json`), `crush`, `goose` (the `extensions` of its `config.yaml`: a `builtin` extension is part of Goose and is left out, and an `env_keys` name comes from the environment), `qwen` (`~/.qwen/settings.json`), and the VS Code extensions `cline`, `roo` and `kilo` (their file in the global storage of VS Code). A new import of a client replaces its file. With no client, the command lists the clients and marks those that have a file. Only you can read the written file, because it can hold keys. A server with SSE only (the old transport of `url` in Gemini, `type: "sse"`) does not connect: the client speaks Streamable HTTP. In the workspace files, `${VAR}` in a string becomes the value of that variable of the environment, and `${VAR:-text}` gives a default. A file that is not valid is skipped with a warning in the daemon log. A change to one of these files starts a new daemon for the next command.

`agency -p` takes `--mcp-config <file|json>`, as Claude Code does: the MCP servers of a JSON file or of JSON text (with or without `mcpServers`) join those of the daemon for that run, and win on a name. The flag can be given more than once. `--strict-mcp-config` uses only the servers of `--mcp-config`. `${VAR}` takes the environment of the command, not that of the daemon. The servers of each distinct `--mcp-config` stay up in the daemon until it ends, so the next run with the same flags finds them started. `agency mcp serve` passes its flags to each turn.

`agency mcp add` takes the flags of `claude mcp add`, so a command from the README of a server works with `agency` in place of `claude`. `agency mcp add <name> -- <command> [args]` adds a stdio server, with `--env KEY=value` (or `-e`) for its environment. `agency mcp add <name> <url>`, or `--transport http` (`-t`), adds an HTTP server, with `--header "Name: value"` (or `-H`). `--transport sse` is refused, because Agency speaks Streamable HTTP only. `agency mcp add-json <name> <json>` takes the entry of a server as `.mcp.json` has it. The server goes to `mcp/added.json` of the user config directory, which only you can read, or with `--scope project` (`-s`) to the `.mcp.json` of the workspace, which loads only in a trusted workspace. A name in use is refused unless `--overwrite` is given. `agency mcp list` shows each server with its origin (`config`, `user` or `project`) and its command or url, and `--format json` prints it as JSON. `agency mcp get <name>` prints one server with the values of its env and headers hidden. `agency mcp remove <name>` removes a server from `mcp/added.json` or the `.mcp.json` of the workspace; a server of another file stays, and the command names its origin.

With many MCP tools, their schemas are most of a request. `mcpDeferTools` controls that. In the `auto` mode, with more than 10 MCP tools, a request has no schema of an MCP tool. It has two tools: `tool_search`, whose description lists the names of the MCP tools, and `call_tool`. The model gives keywords or names to `tool_search`, which gives at most 5 tools with their input schema as text. The model then calls one with `call_tool` (`name`, `input`). That call meets the permission rules, the schema check and the hooks of the tool itself. The tool list of a request never changes, so the prompt cache of the provider holds. `always` does this for any number of MCP tools, and `never` puts every schema in every request. A worker that `spawn` starts with a tool list gets the MCP tools of that list in its tool list. Measured with one server of 31 tools and one run each: 8491 input tokens against 20789 for a task that needs no MCP tool, and 13257 against 20982 for a task that needs one. Those numbers are from the first form, where a found tool joined the tool list. With `call_tool` (3 runs against 2, DeepSeek V4 Flash, the task that needs one MCP tool): 13583 to 14899 input tokens with 8704 to 9472 from the cache, against 13263 to 13279 with 4352 from the cache. The cost that the provider reported did not fall in these runs (0.00087 to 0.00088 USD against 0.00079 to 0.00082); the cause is not known.

An image in the result of an MCP tool goes to the model as an image, and the text of the result has `[image <mime type>]` in its place.

### Agency as an MCP server

`agency mcp serve` makes Agency an MCP server on stdio, as `codex mcp-server` does, so that Claude Code, Codex, Cursor or another client can give a task to Agency. It has one tool, `agency`, with the arguments `prompt` (required), `cwd` (the workspace; default: the folder of the server), `session` and `model` (`provider/model`). Each call is one turn of a session, as `agency -p --session` runs it. The result is the answer and its `session`; pass that `session` to a later call to continue the conversation. A call with no `session` starts a new one (`mcp-<uuid>`). The permission mode comes only from the flags of the server (`--permission-mode`, default `ask`), never from a call, because the caller is a model: with `ask`, a call that needs an approval is refused. For Claude Code: `claude mcp add agency -- agency mcp serve --permission-mode auto`.

A server that declares resources gives the model two tools: `mcp_list_resources` (each resource with its server and its URI) and `mcp_read_resource` (`server`, `uri`). A server that declares prompts gives one slash command for each prompt: `/mcp__<server>__<prompt>`, the name form of Claude Code. The words after the command are the arguments of the prompt in their order, and the last argument takes the rest of the text. The text of the prompt replaces the command as the user message. `mcp_status` and `/mcp` list the commands of a session. The client reads all pages of each list.

## Themes and keybinds (deferred — frontend follows separately)

`theme` is a config key reserved for the future frontend. Keybind and theme registries were part of the removed `packages/tui` package; the backend retains the config key but does not apply it. Frontend will rebuild from these config values.

## Writing config

`updateGlobalConfig(patch)` merges into the global JSONC file and returns the reloaded `Config`. Comments in an existing JSONC file are not preserved.
