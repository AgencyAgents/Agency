# Changelog

All notable changes to Agency are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); the project does not
yet guarantee a stable versioning cadence, but versions are SemVer.

## [Unreleased]

### Changed

- **More rule files**: `.windsurf/rules/` (by `trigger`), `.kilocode/rules/`, Zed's `.rules`,
  `.trae/rules/project_rules.md`, and the `AGENTS.override.md` of Codex in place of `AGENTS.md`.
- **`opencode.json` of a workspace**: its `instructions` files, its `command` map and its
  `agent` map (subagents, with the `tools` it turns off) load in a trusted workspace.
- **`.claude/CLAUDE.md` and `CLAUDE.local.md`**: the other project instruction files of
  Claude Code load beside `CLAUDE.md`.
- **Plugins of the Claude Code settings**: `agency plugin sync` installs the `enabledPlugins`
  of `.claude/settings.json` from the marketplaces of `extraKnownMarketplaces` or those
  Claude Code added; `agency plugin install <plugin>@<marketplace>` installs one; a marketplace
  entry can be a `git-subdir` source.
- **`env` of `.claude/settings.json`**: in a trusted workspace its variables reach each
  shell command, as Claude Code sets them for each session.
- **`agency plugin update <plugin>`**: installs a plugin again from the source of its
  install; its data folder stays.
- **Instructions of subfolders**: the `AGENTS.md` or `CLAUDE.md` of a subfolder reaches the
  model with the result of the first file tool call in that folder, once in a session.
- **Rules of Claude Code**: `.claude/rules/**/*.md` join the instructions of a trusted
  workspace, a rule with `paths` for the files that match them.
- **`@path` imports of `CLAUDE.md` and `GEMINI.md`**: the imported file takes the place of
  the import, five levels deep, from inside the workspace only. A `CLAUDE.md` that only
  imports `AGENTS.md` counts once.
- **User instructions of other agents**: with `"userAgentInstructions": true`, the
  `~/.claude/CLAUDE.md`, `~/.codex/AGENTS.md`, `~/.gemini/GEMINI.md`, OpenCode and Pi user
  instruction files join the instructions of every workspace.
- **Flags of other agents**: a script for `claude -p`, `codex exec` or `pi -p` runs with `agency`:
  `-p` with the prompt after the flags, `--output-format`, `--max-turns`, `-c`, `-r`, the
  permission modes of Claude Code, `--settings` (permissions, model, fallback, effort), `-n`,
  `--resume <name>`, `--fork-session`, `--system-prompt-file`, `--max-budget-usd`, `--effort`, `-C`,
  `--output-schema`, `--no-tools` and others; `agency exec [resume|fork] <prompt>` as `codex exec`.
- **The JSON result of `-p` has the fields of Claude Code**: `result`, `is_error`, `subtype`,
  `num_turns`, `session_id` and `total_cost_usd`, so `jq -r .result` works.
- **`--thinking <level>`**: the reasoning effort of a `-p` run, as in Pi.
- **`--tools <names>`**: `-p` offers only these built-in tools, as in Claude Code. A
  `--disallowed-tools` of `*` takes every tool away, and of `mcp__*` every MCP tool.
- **`-o, --output-last-message <file>`**: `-p` writes the answer to a file too, as `codex exec`
  does.
- **`--fallback-model <provider/model>`**: `-p` goes on with this model when its model stays
  overloaded, as in Claude Code. A fallback can now be another model of the same provider.
- **`-p --worktree <name>`**: the turn runs in the git worktree `.agency/worktrees/<name>`
  on the branch `agency/<name>`, made when missing, as `claude --worktree` does.
- **`--mcp-config` and `--strict-mcp-config`**: `-p` takes the MCP servers of a JSON file
  or of JSON text for one run, as Claude Code does in CI.
- **MCP files of more clients**: the project files of Copilot CLI (`.github/mcp.json`),
  Amp, Crush, Qwen Code and Kilo Code give MCP servers, and `agency mcp import` reads the
  user files of Copilot CLI, Amp, Crush, Goose, Qwen Code, Cline, Roo Code and Kilo Code.
- **GitHub Copilot files**: the `.github/instructions/*.instructions.md` files (by
  `applyTo`), the prompt files of `.github/prompts/` as commands, the skills of
  `.github/skills/`, and the custom agents of `.github/agents/` and `.github/chatmodes/`
  load in a trusted workspace.
- **`agency mcp add`, `add-json`, `list`, `get` and `remove`**: add an MCP server with
  the flags of `claude mcp add` (`--env`, `--header`, `--transport`, `--scope`), to a file
  of the user config or to the `.mcp.json` of the workspace, and show where each server
  comes from.
- **`agency session export <id> [-o <file>]`**: the conversation of a session as Markdown,
  as `/export` of Claude Code writes it.
- **Plugins that loop or read the transcript, such as ralph-loop, work**: a command that you type runs its
  fenced ```` ```! ```` blocks as Claude Code does (before, only `` !`cmd` `` ran, and only through
  `command_run`, never for a command typed as a prompt), in the shell of the `bash` tool rather than cmd.exe;
  `plugin install` expands `${CLAUDE_PLUGIN_ROOT}` in commands; a hook gets `transcript_path`, and
  `session_id: default` for a turn with no session (before, a Stop or tool hook of such a turn had none);
  shell commands get `CLAUDE_CODE_SESSION_ID`. Live: `/ralph-loop` of the official marketplace wrote its
  state file; before, the model got the script as text and searched the repository for minutes.
- **`agency import`: what you set up in other agents, with one question per set**. It finds
  the MCP servers of the user files of 19 clients, the user hooks of Claude Code, Codex, Cursor
  and Gemini CLI (with the `env` of the Claude Code settings, which those hooks get), the plugins
  that Claude Code installed, and the user instructions and code plugins of other agents, and
  shows each set (each hook with its command) before it asks. `--yes` imports all, `--dry-run`
  only shows; a set that is imported already is not asked again. `agency onboard` asks the same
  questions, and bare `agency` names the command when it finds something. Before, the user hooks
  of `~/.claude/settings.json` did not load at all. Settings with no counterpart here (`model`,
  `permissions.defaultMode`) are named.
- **The plugins of a Claude Code user come over in one command**: `agency plugin sync` installs
  each plugin that `enabledPlugins` of `~/.claude/settings.json` turns on, from the copy that
  Claude Code installed, with no download, and `--scope user` installs any plugin for the user.
  Plugins of the user load in every workspace (skills, commands, agents, hooks, MCP and LSP
  servers, modules, output styles). Before, a plugin installed per workspace only, and the
  plugins of Claude Code did not come over: on a real setup, `plugin list` and `mcp list` showed
  nothing for 7 enabled plugins; now all 7 install. A plugin with no `plugin.json` (`strict:
  false`, as the LSP plugins of `claude-plugins-official`) takes its marketplace entry as its
  manifest.
- **`context: fork` of a skill**: the skill runs in a subagent of its `agent` type and `model`, and
  the model gets only the answer, as in Claude Code.
- **`allowed-tools` of a skill**: its rules run with no prompt for the rest of the turn that loads
  the skill, by the model or by `/<name>`, as in Claude Code; a deny rule or an ask pattern still
  holds. `${CLAUDE_SKILL_DIR}` works in a rule.
- **Old tool results leave the requests**: a result over 2,000 characters of a tool that can run
  again (`read`, `bash`, `grep`, `glob`, `fetch`, `websearch`, `lsp_*`) that is over 10 model
  calls old becomes a one-line note, in batches of 20,000 tokens decided by a replay of the
  history, so the prompt cache holds between two batches. Replayed on a long recorded session
  (6,354 requests): 25% fewer input tokens and 19% lower cost with cache prices. The session keeps
  the whole results; `keepToolResults: true` turns it off.
- **MCP servers over SSE**, the older HTTP transport that many servers still use: `type: "sse"`,
  a url that ends in `/sse`, the `url` of Gemini CLI and `agency mcp add --transport sse` connect,
  where before they were refused or failed. The endpoint that the stream names must have its origin.
- **Shorter shell output with nothing lost**: colour codes go, a line that a progress bar redrew
  keeps its last text, and a run of the same line is one line and its count.
- **`agency usage [--by day|month|model] [--since YYYY-MM-DD] [--json]`**: the calls, tokens
  and cost of the model calls of all workspaces, from the traces of the sessions, as ccusage
  reports them for Claude Code.
- **Skills as Claude Code reads them**: a skill is also the command `/<name> [arguments]`;
  `disable-model-invocation`, `user-invocable`, `when_to_use`, `${CLAUDE_SKILL_DIR}`,
  `$ARGUMENTS` and `$ARGUMENTS[N]` work; frontmatter takes quotes, `>` and `|` blocks and lists.
  A skill with no `description` is listed by the first line of its body, where before its whole
  body went into every system prompt.
- **Hooks change a tool call and its result**, as in Claude Code: `PreToolUse` runs before the
  permission check, and its `updatedInput` replaces the input that the rules judge and the tool
  gets; `permissionDecision` `allow` answers a default prompt and `ask` asks though a rule
  allows; its `additionalContext` reaches the model. `updatedToolOutput` of `PostToolUse`
  replaces the result. OpenCode plugins (`output.args`, `output.output`) and Pi extensions
  (`event.input`, `content` of `tool_result`) do the same. A command-rewriting hook such as that
  of rtk now works.
- **Read-only shell commands run without a prompt**, as in Claude Code: `ls`, `cat`, `head`,
  `grep`, `find`, `wc`, `diff`, `cd`, `git status`, `git diff`, `git log` and similar, on
  files of the workspace. Before, `-p` in `ask` mode refused even `ls`. An absolute path, `..`,
  `~`, `$`, an unquoted glob, a `.env` file, a redirect to a file, recursive `grep`, `git` after
  `cd`, or an `ask` or `deny` pattern for the command still asks.
- **PDFs**: `read` attaches a PDF, as Claude Code reads one: a document for Anthropic, a file
  for the Responses API, and a file for OpenRouter, parsed to text with its free engine for
  any model. `-p --image <file>.pdf` sends one with the prompt.
- **Jupyter notebooks**: `read` shows a `.ipynb` as its cells and the text of their
  outputs, and a new `notebook_edit` tool replaces, inserts or deletes a cell, as the
  NotebookEdit tool of Claude Code does.
- **`CLAUDE_ENV_FILE`**: a `SessionStart` hook gets it, as in Claude Code, and the
  `export` lines that it writes there become variables of the later shell commands of
  the session.
- **Permission rules of Claude Code**: the `permissions` of `~/.claude/settings.json`
  and, in a trusted workspace, of `.claude/settings.json` and `.claude/settings.local.json`
  apply (`Bash(git push *)`, `Edit(src/**)`, MCP tools), with deny winning, under
  those of the config. `-p` takes `--allowed-tools` and `--disallowed-tools` (also
  `--allowedTools`, `--disallowedTools`) for one run.
- **Output styles**: `"outputStyle"` names a Markdown style of `.agency/output-styles/`,
  `.claude/output-styles/`, the config folder or `~/.claude/output-styles/`, whose text
  joins the instructions. A plugin installs its `output-styles/`.
- **Memory**: a `memory` tool keeps notes for the later sessions of a workspace, in a file
  of the user's data folder, and each turn has them in its instructions, as the auto
  memory of Claude Code. `"memory": false` turns it off. The notes come as background,
  for a request that is about them: a note "remember 4172" made DeepSeek V4 Flash answer
  4172 to "What is 17 * 23?" in 8 of 50 runs before that line, and in 4 of 50 after it.
- **npm plugins of OpenCode**: a trusted workspace loads the plugins of the `plugin`
  key of `opencode.json` from where npm or OpenCode installed them (the workspace, or
  the cache of OpenCode). Agency installs no package. With `userAgentPlugins: true`,
  the user plugins of OpenCode and the user extensions of Pi load too.
- **`agent` hooks**: a hook can give its question to an agent with the read tools of the
  session (`read`, `grep`, `glob`, at most 50 steps), which answers `{"ok", "reason"}`
  as a prompt hook does.
- **`mcp_tool` hooks**: a hook can call a tool of an MCP server of the session, as in
  Claude Code. `${path}` in its `input` takes values of the event, and the text of the
  tool answers as the stdout of a command.
- **More of a Claude Code plugin**: `agency plugin install` puts the `bin/` folder of a
  plugin on the PATH of shell commands, gives `${CLAUDE_PLUGIN_DATA}` a data folder,
  gives a hook `CLAUDE_PLUGIN_ROOT` and `CLAUDE_PLUGIN_DATA` in its environment, maps
  `${user_config.KEY}` to the variable `${CLAUDE_PLUGIN_OPTION_KEY}`, installs a root
  `SKILL.md` and commands that the manifest maps by name, and names the parts that do
  not install (themes, monitors, workflows, `settings.json`).
- **LSP servers of plugins**: the `.lsp.json` and `lspServers` of a Claude Code plugin
  install to `.agency/lsp/<plugin>.json`, and a trusted workspace starts them as the
  `lspServers` of the config.
- **`agency mcp serve`**: Agency is an MCP server on stdio with one tool, `agency`, that
  runs a turn of a session, so that Claude Code, Codex or Cursor can give it a task. The
  permission mode comes from the flags of the server, never from a call.
- **Rules and MCP files of Roo Code, Kiro, Junie, Augment and Continue**: their rule
  files join the instructions of a trusted workspace, with the `inclusion` of Kiro and
  the `type` of Augment mapped, and `.roo/mcp.json` and `.kiro/settings/mcp.json` give
  MCP servers.
- **User files of other agents**: the user skills, commands and agent files of Claude
  Code, Codex, Cursor, Pi, OpenCode, Gemini CLI and the shared `~/.agents` load in every
  workspace, below those of Agency. `AGENCY_AGENTS_HOME=off` turns this off.
- **Code plugins of OpenCode and Pi**: the plugins of `.opencode/plugins/` and the
  extensions of `.pi/extensions/` run in a trusted workspace through a shim of their
  API: tools, the tool-call hooks that block, `shell.env`, events, and Pi's `exec`.
  Agency gives the imports `@opencode-ai/plugin`, `typebox` and the Pi packages. A Pi
  package that `agency plugin install` installs now runs its extensions too.
- **Hooks of other agents**: a trusted workspace runs the hooks of
  `.claude/settings.json`, `.claude/settings.local.json`, `.codex/hooks.json`,
  `.cursor/hooks.json` and `.gemini/settings.json`. Cursor and Gemini events map to the
  events here, and a Cursor hook gets its own input and answers as in Cursor. A
  matcher can name a tool by its name in another agent (`Shell`, `run_shell_command`,
  `WebFetch`). The hooks of a Cursor plugin or a Gemini extension install converted.
- **Plugins of Cursor, Codex, Gemini CLI and Pi**: `agency plugin install` now takes a
  Cursor plugin (rules, skills, agents, commands, `mcp.json`), a Gemini CLI extension
  (context file, TOML commands, MCP servers), the portable `plugin.json` of Codex, and
  a Pi package (skills and prompts; its TypeScript extensions are named as not
  installed). Plugin agents of any format are written as agent files of Agency, so a
  Claude Code agent with keys such as maxTurns or memory no longer fails. The marketplace files
  of Cursor and Codex work as that of Claude Code.
- **Projects of other agents work as they are**: a trusted workspace now gives the
  instructions of `GEMINI.md`, `.cursorrules`, `.cursor/rules/*.mdc` (with
  `alwaysApply`, `globs` and `description`), `.windsurfrules`, `.clinerules` and
  `.github/copilot-instructions.md`; the skills of `.claude/`, `.agents/`, `.cursor/`,
  `.codex/`, `.pi/`, `.opencode/` and `.gemini/`; the commands of `.claude/`,
  `.cursor/`, `.opencode/`, `.pi/prompts` and the TOML commands of Gemini CLI; and
  the agent files of `.claude/`, `.cursor/`, `.codex/` and `.opencode/`.
- **MCP servers of other clients**: a trusted workspace now also gives the MCP servers
  of `.cursor/mcp.json`, `.vscode/mcp.json`, `.gemini/settings.json`, `opencode.json`,
  `.codex/config.toml`, `.pi/mcp.json` and `.zed/settings.json`, with their keys and
  variables mapped. `agency mcp import <client>` copies the user-level servers of
  Claude Code, Claude Desktop, Cursor, Codex, Gemini CLI, OpenCode, Pi, VS Code,
  Windsurf or Zed into the user config of Agency.
- **Plugins from git and marketplaces**: `agency plugin install` takes a git URL or
  `owner/repo` of GitHub (`#ref` for a branch or tag) as well as a folder. A repository
  with `.claude-plugin/marketplace.json` is a Claude Code marketplace:
  `agency plugin install owner/repo <plugin>` installs one of its plugins, also one
  that the marketplace names by its own git source.
- **Auto permission mode**: `--permission-mode auto` (and `permissionMode: "auto"`
  of `run_turn`) lets a reviewer model answer the asks, as the auto mode of Claude
  Code does. Edits run; another ask of a default rule goes to `auto_review_model`
  (default `small_model`). It sees your messages and the agent's tool calls, never a
  tool result. A block gives the model the reason; after 3 blocks in a row or 20 in a
  turn, or with no verdict, you are asked (with `-p`, the call is refused). A new
  `PermissionDenied` hook runs on a block, and `retry: true` lets the model try again.
- **Use your ChatGPT plan**: `agency auth login chatgpt` signs in with ChatGPT as
  OpenAI documents it for open-source apps, and `chatgpt/<model>` then runs on the
  plan through a new Responses API adapter. `agency auth logout <provider>` removes
  a key or revokes the ChatGPT sign-in. Tested against a local server only. A Claude
  plan cannot be used: Anthropic's terms do not permit it in another app, and
  `auth login anthropic --oauth` now says so.
- **Prompt hooks**: a hook of `"type": "prompt"` asks a model (`small_model` by
  default) whether the event meets a condition, and `{"ok": false, "reason"}`
  blocks, as in Claude Code. Live: a `Stop` hook made DeepSeek V4 Flash add a word it
  had left out, then let the turn end. `agency plugin install` now installs the
  prompt hooks of a plugin; it skipped them before. `Stop` and `SubagentStop` hooks
  get `last_assistant_message`, the text of the last reply.
- **HTTP hooks**: a hook of `"type": "http"` sends the event as a JSON POST to its
  `url`, and its JSON answer blocks or adds context as the stdout of a command does.
  Headers can hold the environment variables of `allowedEnvVars`, as in Claude
  Code. Before, a config with an http hook was not valid, and the daemon did not
  start. A plugin with http hooks now installs them.
- **Shell commands can reach a list of hosts**: `sandbox.allowedDomains` with the `os`
  backend gives a command only the hosts in the list (`github.com`, `*.npmjs.org`),
  through a proxy of the daemon, as in Claude Code. Before, a command had all of the
  network or none of it. Linux needs `socat`; Windows refuses the list.
- **The OS sandbox ran on Linux**: real commands under bubblewrap (WSL 2, Ubuntu):
  a write outside the workspace and a direct connection are denied. Before, only
  the arguments had tests. The same test runs on macOS in CI.
- **`PostToolBatch` hook**: runs once after all tool calls of one reply, with
  each call and its result, before the next request. A block ends the turn
  with the reason; `additionalContext` reaches the model once. For example, one
  lint or test run after a batch of edits, in place of one for each edit.
- **Web search with no setup for OpenRouter users**: with no `websearch.endpoint`,
  the `websearch` tool searches through OpenRouter's web plugin when the
  `openrouter` provider has a key, and gives 5 results with title, URL and
  an excerpt. Before, the tool was not offered without an endpoint. Live: one
  search found the Bun 1.4 release page and the model gave its date. A search
  costs about 1 cent, which the cost of the turn does not count.
- **Sign-in to MCP servers over HTTP**: `agency mcp login <server>` runs the OAuth
  flow of the MCP authorization spec (metadata discovery, client registration,
  PKCE in the browser) and keeps the tokens in the OS keychain; `agency mcp`
  `logout` removes them. A session sends the token and refreshes it. Before,
  such a server needed a key in `headers`. A failed start of an MCP server
  now keeps its reason; before, it read "crashed".
- **The OS sandbox protects more of the workspace**: a command can no longer
  write `.git/config` or the hooks, MCP servers and plugins of `.agency`,
  which the harness runs outside the sandbox later. `.agency/worktrees` stays
  writable for teams. On Linux and macOS `.git` cannot be renamed and the
  data and config folders of Agency cannot be read (tests of the arguments
  only). On Windows a write is denied and `git commit` still works
  (measured); the token there does not stop delete and rename.
- **Data and config folders are private on Linux and macOS**: each start of
  `agency` sets them to `0700`. Before, they had the mode of the umask,
  often `0755`, so another user of the machine could read the sessions and
  logs. Not run on Linux or macOS yet: the test skips on Windows.
- **Fast steps no longer wait for the request rate**: the daemon paces a known
  provider at the rate of its API (`openrouter` 200 a minute, `openai` 500), which
  the provider table had but the daemon did not use. Before, each provider got 60
  a minute, so after 6 quick requests each step waited 1 s. Measured: a turn of
  25 fast tool steps through `openrouter` took 20.1 s, now 2.2 s.
- **More git commands that lose work ask first**: `git checkout` with `--`,
  `.` or `-f`, `git restore` of the working tree, `git stash drop`,
  `git stash clear` and a remote branch delete through `git push` now ask in
  spite of a pattern rule that allows them, as `git reset --hard` did.
- **A saved key reads in under 15 ms on Windows**: the key store calls DPAPI
  in `crypt32.dll` directly. Before, each read and each save started
  PowerShell: about 430 ms for each turn with a key from `agency auth login`.
  Measured on one machine: read 430 to 13 ms (under 1 ms after the first), save
  454 to 5 ms. The file format is the same in both directions.
- **Secret variables stay out of model commands**: a `bash` command of the
  model no longer gets a variable with `KEY`, `SECRET` or `TOKEN` in its
  name, nor one that `provider.<id>.env` names, as in Codex. Before, only
  `AGENCY_<ID>_API_KEY` was removed, so `<ID>_API_KEY`, a name that the
  harness reads its key from, reached each command. The new
  `sandbox.allowEnv` gives back names that a command needs, such as `GH_TOKEN`.
- **Schema check at any depth**: the check of a tool input, and of a
  `--json-schema` answer, now reaches nested objects, arrays of
  objects, `enum` in array items and a list of types. Before, it
  covered the top-level properties only, so a wrong nested value
  passed. `pattern`, `minimum`, "oneOf" and "$ref" are not checked.
- **Deferred MCP tools keep the tool list fixed**: `tool_search` now
  gives the input schema of a found tool as text, and the model
  calls the tool with the new `call_tool` (`name`, `input`). Before,
  a found tool joined the tool list, so the next request got no hit
  in the prompt cache of the provider. Measured on one task with one
  MCP call (3 runs against 2): 8704 to 9472 input tokens from the
  cache, against 4352. The cost that the provider reported did not
  fall in these runs; the cause is not known. A `code` script can
  call a deferred MCP tool with no search.
- **Tokens in the output of a command**: the result of a `bash` or
  `code` call loses tokens by their shape before the model and the
  provider get it: keys of Anthropic, OpenAI, OpenRouter, Google,
  GitHub, AWS, Slack, npm, and private key blocks. Before, only the
  provider keys of the harness were removed, so the output of
  `gh auth token` went to the provider as written. A file tool keeps
  such text. A password with no known shape still passes.
- **A destructive command asks in spite of a pattern rule**: with a
  rule such as `"git *": "allow"`, the commands `git push --force`,
  `git reset --hard`, `git clean -f`, `git branch -D`, `rm -r`,
  `find -delete` and a small fixed list of disk tools now ask. The
  bare decision `"bash": "allow"` and the `allow-all` mode do not
  ask, as before. The idea is from the dangerous-command check of
  Codex.
- **Prompt cache across the turns of a session**: the environment block
  of the system prompt (date, git branch, git state) is made one time
  for each session and day, is stored next to the session, and has the
  label `git at session start`. Before, a
  turn that changed the work tree changed the block, and the next turn
  paid full price for the full history. Measured in one two-turn
  session: 0 of 21820 input tokens of turn 2 came from the cache
  before, 17895 of 21824 after.
- **Patterns in `sandbox.denyEnv`**: a name can have `*`, for example
  `*TOKEN*`. Before, each variable needed its exact name.
- **Compaction keeps your messages word for word**: the summary of a
  compacted session ends with the messages that the user wrote, as
  written, and they go on through later compactions. Before, the model
  rewrote them in the summary, so a rule could be lost or changed.
- **`PostToolUse` hooks**: a `PostToolUse` hook runs only for a tool
  call that succeeded, as in Claude Code. A failed call runs the
  `PostToolUseFailure` hooks. Before, `PostToolUse` ran for both.
- **Shell of a hook command**: a hook command runs in the shell of the
  `bash` tool (Git Bash on Windows when it is installed). It was
  `cmd.exe` on Windows, where a hook that is a shell script did not
  run.
- **Skill files of a plugin**: `agency plugin install` copies the whole
  folder of a skill. It copied only `SKILL.md`, so a skill could not
  read its own reference files.
- **Step limit**: a turn takes at most 100 tool steps by default. It was
  25. `maxSteps` in the config and `--max-steps` set another limit.
- **Permissions of a spawned worker**: a worker now has the permission
  mode of the run that started it, and its asks go to the approval
  surface of the parent turn. Before, a worker had no mode and no
  approval surface, so it could not change a file or use the shell
  even in an `allow-all` run. A worker also gets the environment block
  (folder, shell, date) that it lacked.
- **Skills load on demand**: a skill with a `description` is one line
  in the system prompt, and the model loads its body with the new
  `skill` tool. Before, the full text of every skill was in every
  request. Measured with one skill of 60 rules: 4092 input tokens for
  an unrelated prompt, against 6208 with the body in the prompt. A
  skill with no description stays in the prompt in full.
- **`/goal` is now the session goal**: the team report that `/goal`
  returned is now `/report [outcome]`. The `report_get` RPC did not
  change.
- **Perseverance legacy path**: the legacy import file is now `.omo/perseverance.json` (`LEGACY_PERSEVERANCE_FILE`), completing the rename with zero old-name references left. Clean break with no back-compat shim: legacy files already on disk under the previous name are no longer picked up, so move such a file to the new name to keep its state.
- **Dispatch path**: `packages/cli/src/daemon.ts` runs delegation inline:
  `dispatch` tool on a flat team path (depth-1 nesting lives only on the
  `spawn` tool), per-agent and team budget caps, cost forecast with
  approval gate, and concurrent peer turns with lean briefs
  (`packages/core/src/team/parallel.ts`).
  `dispatch_compare` runs compare mode: one shared board item that N
  agents `compareClaim`, with a recorded verdict. A lone `@handle`
  mention routes the turn to that agent's provider, model, and effort
  (`parseHandles` at daemon.ts:1872). `planDispatchBatch` in
  `packages/core/src/team/dispatch-core.ts` plans every batch with 5
  skip codes; the inline skips stay as race guards.
- **Per-agent permissions**: every dispatched peer carries its own
  capability set so the guard enforces tool-level, path-level, and
  command-level rules per agent identity, not per-daemon-default
  (`packages/guard/src/policy.ts`). Approval grants are session-scoped and
  persist across daemon restarts (`packages/guard/src/approval.ts`).
- **HTTP+SSE gateway**: `packages/rpc/src/http-gateway.ts` mounts a full
  HTTP+SSE transport exposing the RPC surface (tools, sessions, daemon
  lifecycle) over standard ports, with streaming responses via SSE.
- **8-agent roster**: `DEFAULT_ROSTER` (`packages/core/src/config/schema.ts`)
  defines leader, planner, plan-reviewer, coder, executor, explorer,
  researcher, and code-reviewer, spread across anthropic, openai, and
  google by role. A dispatched peer without credentials for its provider
  runs on the lead turn's provider and model (`routeAgent`).
  Dispatched peers do not receive per-role prompts: `resolveFamilyPrompt`
  (`packages/core/src/prompt/compose.ts`) has no runtime caller, and each
  peer turn uses a literal one-line prompt with its handle and role
  (daemon.ts:1313). Cross-provider fallback is a single `fallback_model`
  retried once on overload, transient, or rate-limit errors, not
  per-category chains: `runWithCategoryFallback` has no runtime caller.
- **Per-handle worktrees**: the daemon assigns each agent a fixed worktree
  at `.agency/worktrees/<handle>` (`packages/cli/src/daemon.ts`). If
  worktree creation throws, the peer falls back to the workspace root,
  so isolation is best-effort, not enforced.
- **Bash isError + labels**: `packages/tools/src/builtins/bash.ts` now sets
  `isError` on non-zero exit and attaches a descriptive `label` to every
  tool call, improving error attribution in team dispatch results.
- **Session titles**: `packages/core/src/sessions/titles.ts` auto-generates
  session titles from the first user message via `resolveSmallModel`,
  stored as `session_title` entries in the session file. There is no
  session-list RPC; reads go through `session_show`.
- **Ed25519 signing**: `scripts/sign-release.ts` signs release binaries
  with Ed25519 detached signatures, verified by the install scripts before
  extraction (`scripts/sign.sh` / `scripts/sign.ps1`).
- **Sandbox and trust fixes**: `packages/guard/src/sandbox.ts` now returns
  typed `EACCES` refusals instead of generic
  rejections. The trust gate (`packages/guard/src/trust.ts`) inherits
  downward: trusting a parent directory covers all subdirectories.
- **Zero Biome warnings**: all files pass `biome check --no-errors-on-unmatched` clean with `complexity: { noBannedTypes: "off" }`
  and strict no-implicit-any enforcement. `scripts/sg-helper.ts` codemod
  tool added for AST-aware slop removal.

### Fixed

- **A deny rule behind `timeout`, `stdbuf`, `builtin` or `noglob`**: a deny of `rm *` let
  `timeout 5 rm -rf build` run. These wrappers are now taken away before the rules, as Claude
  Code does.
- **A Read or Edit deny rule and the shell**: with a deny of `Read(secret.txt)`, the model
  printed the file with `cat secret.txt` (seen live). The rule now holds for the files that a
  shell command names (`cat`, `head`, `grep`, `sed`, `< file`; `tee`, `sed -i`, `> file`), as
  in Claude Code.
- **An `Edit` rule of Claude Code** held for `edit` only: a deny of `Edit(secrets/**)` let `write`
  and `notebook_edit` change those files. It now holds for each tool that edits files, and a bare
  `Read` rule for `grep` and `glob` too, as in Claude Code.
- **A blank line on the stdout of a stdio MCP server**: the reader of its messages
  looped on it for ever, and the daemon stopped answering every run of the workspace.
  Seen with a server that printed a help text and exited.
- **A deny rule on one command**: the refusal said that the whole tool was not
  permitted and not to call it again, so a model gave up on the other commands of the
  task. A refusal of a command or a path now names that call and says that another call
  of the tool can be permitted.
- **`shell.env` hooks**: the variables that a `shell.env` hook of a plugin set did not
  reach the shell command, and an async hook ran after the command started. The loop
  now waits for the hooks and gives their variables to the command, also to a command
  in the background.
- **MCP lists in pages**: the client read only the first page of the
  tools, resources and prompts of a server, so a server that gives
  its lists in pages lost the rest with no error. It now reads all
  pages.
- **A deny rule did not hold in a group or a control structure**
  (security): with a rule that denies `rm *`, these ran after an ask
  or with a wide allow rule: `{ rm -rf build; }`, `(rm -rf build)`,
  `if true; then rm ...`, a `case` arm, a function body, `eval "rm
  ..."`, `xargs rm`, `find -exec rm`. The rules now see those
  commands. A here-document, a here-string, a `$'...'` string and a
  variable as the program (`$TOOL build`) are never allowed by a
  rule: they ask.
- **`--json-schema` and `tool_search` with a denied tool**: when the
  config denied a tool fully (for example `"write": "deny"`), the
  calls of `structured_output` and `tool_search` were refused as
  "outside this caller's allowed tools", so a run gave no structured
  answer and could load no MCP tool.
- **A deny rule did not hold behind a wrapper** (security): with a
  rule that denies `rm *`, the commands `sudo rm -rf build`,
  `env A=1 rm -rf build`, `/bin/rm -rf build` and
  `bash -c "rm -rf build"` were not denied. The rules now also see the
  command behind a wrapper, a path, an assignment or a shell.
- **A permission rule allowed the commands after an allowed one**
  (security): with a rule that allows `git status*`, the command
  `git status; rm -rf build` ran with no ask, because a rule saw only
  the first words. An "always allow" answer had the same fault. A
  compound command is now judged part by part, and a command with a
  substitution asks.
- **Session of an HTTP MCP server**: the HTTP transport did not send
  back the `Mcp-Session-Id` that a server gives in the handshake. A
  server with sessions refuses each later request without it. Shown
  with a test server that has sessions: no server of an official SDK
  was run.
- **MCP handshake**: the `initialize` request had no `protocolVersion`
  and no `capabilities`, which the MCP specification makes mandatory.
  A server that validates the request refuses it. The request now has
  them (`2025-03-26`). Found by reading and shown with a strict test
  server: no server of an official SDK was run.
- **`session.start` for a kept session**: a plugin hook on
  `session.start` did not run for a session that `--session`,
  `--continue` or `session_send` made. The event came only for a
  one-shot turn. It now comes one time when the session is made.
- **A cancelled command left a program of Git Bash alive**: on Windows a
  cancel or a time limit stopped the shell with `taskkill /T`, which
  follows parent links. A program of Git Bash (`sleep`, a shell script)
  has a parent that is already gone, so it stayed alive. Each command
  now runs in a Windows job object, and a kill stops the whole job.
- **Project instructions of a spawned worker**: a worker did not get
  `AGENTS.md`, `CLAUDE.md` or the rules of the workspace, so it could
  not follow the rules of the project. In a trusted workspace a worker
  now gets them in its system prompt.
- **One agent file that is not valid**: one agent file with an error
  made the daemon drop every agent file and use the roster of the
  config. The daemon now skips that file with a warning in its log,
  and the other files load.
- **Two daemons for one workspace**: two calls of one process that
  looked for the daemon at the same time (two agents of a workflow in
  parallel) each started a daemon, because the spawn lock takes a
  holder with its own process id for a leftover. The calls of one
  process for one workspace now run one after the other.
- **A daemon that no client reaches**: a spawned daemon started its
  idle timer only when a client left, so a daemon that never had a
  client stayed for all time and held the binary. Its linger now runs
  from the start.
- **Provider keys in tool results**: a tool result that held a
  provider key (the output of `env`, a config file that the model
  read) went to the model and into the result of the turn as it was.
  The keys that the daemon knows are now replaced with `[REDACTED]`
  in each tool result, for the main turn and for workers.
- **Provider keys in the environment of a shell command**: a command
  of the `bash` tool had the provider keys of the harness
  (`AGENCY_<ID>_API_KEY`) in its environment, so a command could print
  a key into the transcript or send it out. These variables are no
  longer given to a command, in the foreground or in the background.
- **A run directly after a config change used the old daemon**: an idle
  daemon checks its config each second, so a command that started in
  the same second as `agency trust`, a config edit or a plugin install
  ran on the old state. A hook that was installed a moment before did
  not run. A daemon with no client now refuses the first client when
  its config, the trust list or a hook file changed, and the command
  starts a new daemon. A daemon that stops no longer deletes the
  instance file of the daemon that took its place.
- **Plugin names that are paths**: a plugin whose manifest name or
  skill name was a path such as `../..` could write outside
  `.agency`, and `agency plugin remove ..` deleted the `.agency`
  folder. The install now refuses such a name, and the removal
  ignores a path in its argument and in a receipt.
- **Daemon start limit**: the CLI waited 5 s for a new daemon. On a slow
  machine the daemon needs longer (13 s or more on an emulated CPU about five
  times slower than a laptop), so the first run failed and left a daemon
  behind. The limit is now 30 s (`DEFAULT_SPAWN_TIMEOUT_MS`), and the message
  says that a second run can connect.
- **Key in error text**: a failed request's error showed the full address.
  For Gemini the address held the API key, so the key went to stderr, logs
  and the session. The error now shows the address without its query and
  login (`packages/net/src/http.ts`), and the Gemini adapter sends the key in
  the `x-goog-api-key` header.
- **Gemini request format**, from Google's API documentation and not
  confirmed against the live API. A request that used a cache also sent a
  system instruction, which the API rejects: the dynamic part of the prompt
  now leads the contents. A tool schema outside the `parameters` subset (an
  MCP server's schema with more JSON Schema keywords or a list of types) made
  the API reject the whole request: such a schema now goes in
  `parametersJsonSchema`. Thinking level `off` sent budget 0 to Gemini 2.5
  Pro, which cannot turn thinking off: it now gets its lowest budget. A set
  thinking level now asks for thought summaries (`includeThoughts`). A test
  now checks real request bodies against the request part of Google's API
  description (`packages/providers/test/adapters/google-wire.test.ts`).
- **Gemini stop reasons**: a blocked prompt (`promptFeedback.blockReason`)
  ended as an empty reply and is now a refusal. A finish reason that is not a
  normal stop, also one that the API adds later, was read as a complete reply
  and is now an error. The reason `CONTINUATION` (the reply reached the
  per-request limit) takes the path of a reply cut at the output limit.
- **OpenAI refusal**: a refusal comes in the stream's `refusal` field, which
  the adapter did not read, so the turn ended as an empty reply. The refusal
  text is now shown and the turn ends as a refusal.
- **Reply that the provider ended with an error**: a turn with text and stop
  reason `error` made the CLI exit with code 1 and no message. The turn now
  carries the error `provider_stop`.
- **Release without the update key**: the release job stopped at the merge of
  the signed checksum fragments when `AGENCY_UPDATE_PRIVATE_KEY` was not set,
  so no release came out. It now publishes with a warning, and
  `agency update` refuses that release as before.
- **CI and release test step**: the release workflow ran `bun test`, one
  process for all tests, which does not finish on Windows. The CI test step
  had several commands, and a Windows runner reports only the last command's
  exit code, so a failed shard passed. No shard ran `packages/eval`. Both
  workflows now run one command, `bun run test:ci`.
- **Progress of a streamed reply**: in text mode `agency -p` printed each
  small part of a streamed reply on its own stderr line, so a real model gave
  a column of word fragments. The parts now collect into whole lines.
- **First runs on a real provider (OpenRouter)**: the defects below came from
  runs of the compiled binary against openrouter.ai, on
  `deepseek/deepseek-v4-flash` and four free models.
  - **Each tool ran twice**: OpenRouter repeats the finish reason on its usage
    chunk, and the adapter ended each tool call on both. A shell command that
    appends one line appended two. A call now ends once.
  - **`unknown provider: openrouter`**: only `anthropic`, `openai` and `google`
    worked without a `provider.<id>.baseUrl` entry. `openrouter`, `deepseek`,
    `groq` and `xai` now use their public endpoints, and `auth list` shows them.
  - **Key names**: a key under the provider's own variable name (for example
    OPENROUTER_API_KEY) was not read, and a name from
    `provider.<id>.env` passed the CLI check but gave the daemon no key. Each
    lookup now reads the declared names, `AGENCY_<ID>_API_KEY`, then the
    provider's own name.
  - **Cost 0**: a turn on a model with no price entry had no cost, so a
    `maxCostUsd` budget never stopped it. The charge that OpenRouter reports
    for each request is now the cost (`usage.costUsd`).
  - **Reasoning**: text in `delta.reasoning` was dropped. It is now thinking.
  - **Error text**: a wrong key gave only "User not found."; it now names the
    provider and the HTTP status. "Provider returned error" now has the
    upstream's name and cause. An unknown model id has the code
    `invalid_request`, not `internal`.
  - **Rate limits**: a rate limit got 4 attempts in 3.5 s. Measured limits of
    free models clear in 11 s to 22 s, so it now gets 7 attempts (about 30 s),
    and each retry shows as a `Retry <n>` line.
  - **Error in the middle of a stream**: OpenRouter reports a failure after
    the stream began with HTTP 200 and the finish reason "error". The adapter
    took it as the end of a good reply. It now fails the request. This case
    was not seen live; the test uses the form in OpenRouter's documentation.
  - **Empty tool result**: a shell command with no output gave an empty
    result, and Cohere (through OpenRouter) rejected the next request with
    400. An empty result now has the text "(no output)".
  - **Refused tool call**: the refusal now tells the model not to send the
    call again. Measured on a free model over five runs: 15 repeated calls on
    average before, 1 after.
- **Image file**: a wrong path for the image option was dropped without a
  word, so the prompt went out with no image. The run now stops with an
  error, and the help text lists the option.
- **Key variable for an id with a hyphen**: the id `my-gateway` gave a
  variable name that a POSIX shell cannot set. A character that is not a
  letter or a digit is now an underscore.
- **Shell on Windows**: with no `windowsShell` value the shell tool now uses
  Git Bash when Git for Windows is installed, and PowerShell otherwise.
  Models write bash by habit, and Windows PowerShell 5.1 rejects it.
  Measured on a free model with one coding task: about 24 tool calls and 13
  tool errors a run in PowerShell (3 of 6 runs finished), about 10 calls and
  1.5 errors in Git Bash (6 of 6 finished). Git Bash mode also lost each
  directory change, because it read the directory in the MSYS form. It now
  reads the Windows form.
- **Drive path from Git Bash**: Git Bash prints the C drive as `/c/...`. A
  model copied that form into the read, edit and write tools, and each call
  failed with "resolves outside the sandbox root". The file tools and the
  permission rules now read that form as the same Windows path.
- **Half line at a cut**: the output limit cuts a reply in the middle of a
  line, and the model writes that line again when it continues, so the
  half line stayed in the reply as a stray line. The reply now continues
  from its last complete line. Measured on DeepSeek V4 Flash with a
  1500-token limit: 1 of 7 continued replies was clean before, 6 of 6 after.
- **Clients that start together**: when several clients started at one time
  with no daemon, a client could take the start lock from a client that had
  created it and not written it yet. Two daemons then started for one
  folder, and one stayed behind with no client. On Windows a client could
  also stop with `EFAULT` or `EPERM` on the lock file. A lock with no
  content is now held until it is old, and an error on the lock file no
  longer stops a client. Measured with 12 clients at one time over 100
  rounds: 41 rounds with two starts and 7 with an error before, 0 and 0
  after.
- **Session entry lost on Windows**: when two processes wrote to one session
  at one time, for example a session rename during a turn, an append could
  stop with `EPERM` on the session lock, and its entry was lost. The append
  now waits for the lock. Measured with two processes and 3000 appends:
  8 to 11 lost before, 0 after.
- **Config value of the wrong type**: the error was a JSON list of schema
  issues with no file name. It is now one line that names each key, the
  problem, and the config files that were read.
- **Token counts on the Anthropic wire format**: the adapter read the input
  token count only from the first stream event. A gateway that speaks the
  Messages format (OpenRouter) sends zero there and the real counts, with
  its charge, in the last event, so a turn showed 0 input tokens and no
  cost, and the budget did not count it. The adapter now reads the counts
  and the charge from both events. Live through the Messages endpoint of
  OpenRouter: 0 input tokens and no cost before, 3952 and a charge after.
- **Output limit used by thinking**: when a model used the whole output
  limit before any answer text, the error said only that the reply was cut.
  It now gives the limit in tokens and names the setting to raise.
- **Limits of an OpenRouter model**: a model with no config entry ran with
  an assumed window of 200000 tokens and an output limit of 8192. The daemon
  now reads OpenRouter's public model list one time, with no key, and uses
  the real window, the prices, and an output limit of at most 32000 tokens.
  A failed read keeps the defaults. Measured on DeepSeek V4 Flash with a
  reply of about 16000 tokens: 2 cuts and a list that ran past its end
  before, one exact reply after.
- **Plugin code of an untrusted workspace**: the daemon ran each
  `.agency/plugins/*.js` file of a workspace at start, also when the user had
  not trusted that workspace. The daemon now loads the plugins, skills and
  plugin instruction files of a workspace only after `agency trust`, and the
  CLI notice names them. Plugins and skills in the user config directory load
  as before.
- **Agent and command files of an untrusted workspace**: a file in
  `.agency/agents/` could give its agent the shell with a `permissions`
  line, and a file in `.agency/commands/` could hold a shell block that
  `command_run` ran. Both loaded in a workspace that the user had not
  trusted. They now load only after `agency trust`, and the daemon writes no
  default agent files into an untrusted workspace. `agency plugin install`
  says when the workspace is not trusted. Measured on DeepSeek V4
  Flash in an untrusted workspace: a dispatched agent from such a file ran a
  shell command before, and the agent is unknown after.
- **Shell of a dispatched agent**: in the default mode the main turn could
  not use the shell, but an agent that the main turn dispatched could. The
  default roster allows `bash`, `write` and `edit` for some agents, and the
  agent's map replaced the global permissions. The global `permissions` and
  the mode of the run are now a ceiling for each agent: the stricter verdict
  wins. In the default mode a dispatched agent can only read.
  `--permission-mode allow-all`, `allow-edits`, or an `allow` entry in the
  global `permissions` gives it more. Measured on DeepSeek V4 Flash: a
  dispatched `coder` ran a shell command in the default mode before, and is
  refused after. With `allow-all` the command runs.
- **Output of `agency -p` in text mode**: stdout held every text of the
  turn, so a sentence that the model wrote before a tool call came before the
  answer. Stdout now holds the answer only: the last assistant message and
  the parts that an output-limit cut joins to it. The earlier text stays on
  stderr as progress, and `--format json` still holds every message. A turn
  that stops before an answer prints the text that it has. Measured on
  DeepSeek V4 Flash: in 2 of 6 runs the model wrote such a sentence and
  called the shell although the prompt said no tools.
- **File tools of a dispatched agent**: the shell of a dispatched agent ran in
  its git worktree, but its `read`, `write`, `edit`, `glob` and `grep` tools
  used the main workspace. An agent that changed a file and then ran the
  tests, tested the old code, and it could not read a file that its own
  shell had made. The file tools now start at the worktree too. The work
  stays in `.agency/worktrees/<session>/<handle>` until it is merged, and
  the dispatch result names that folder and its branch.
- **Plugin commands**: `agency plugin list` showed the receipt folder of a
  plugin as a skill. It now shows `(plugin)`. `agency plugin remove` with
  the name of one skill of a plugin removed that skill and left the receipt.
  It now refuses and names the plugin. A second `agency plugin install`
  printed a JSON log line. It now prints the text and names `--overwrite`.
- **Skill and plugin text**: the body of a skill and the `agentsMd` text of a
  plugin never reached the system prompt. They are now added after the
  project instructions.
- **Dropped HTTP request**: a turn started with `POST /rpc` ran on after its
  client left, with its shell command still alive. A request that is dropped
  before the call ends now cancels the turn, as a closed TCP connection does.
- **Cancel on Windows**: a cancelled or timed-out shell command left the
  programs that it started running, because the shell was killed before its
  process tree. The tree is now killed first.
- **Rollback**: `agency update --rollback` is in the help text and the docs,
  but the option parser rejected it with "Unknown option". The parser now
  knows the option (`parseArgv` in `packages/cli/src/entrypoint.ts`). With no
  release on GitHub, `agency update` now says so in place of a bare 404.
- **Install on Windows**: in Windows PowerShell 5.1 the download of the 86 MB
  binary took 129 s, because the shell draws a progress bar for each chunk.
  `scripts/install.ps1` now downloads without the bar (0.2 s from a local
  server). On ARM64 the script asked for a binary that no release has, and
  now says that there is no ARM64 build. `AGENCY_NO_MODIFY_PATH=1` leaves
  the user PATH as it is (`scripts/install-ps1.test.ts`).
- **Install on macOS**: `scripts/install.sh` verified the download with
  the sha256sum tool, which macOS does not have, so the install stopped with
  "checksum mismatch". It now uses shasum when sha256sum is absent
  (`scripts/install.test.ts`).
- **First run**: `agency -p` failed with `ENOENT` on a machine with no data
  directory, because the daemon spawn lock was created before its directory
  (`ensureDaemon` in `packages/rpc/src/instance.ts`).
- **Release binary**: the compiled binary spawned its daemon as
  `bun run daemon-entry.ts`, which needs Bun and the source tree. It now
  re-runs itself through `DAEMON_COMMAND` (`packages/cli/src/headless.ts`).
- **Team dispatch**: a dispatched peer whose pinned provider had no key sent
  an unauthenticated request. `routeAgent` now runs it on the lead turn's
  provider, model and key. The startup remap that never took effect is gone.
- **Project instructions**: `loadInstructions` had no caller, so `AGENTS.md`,
  `CLAUDE.md` and `.agency/rules` never reached the model. The daemon loads
  them for a trusted workspace; `agency trust` trusts one without onboarding.
- **Shell exit codes**: a command that ends the shell (`exit 3`, `set -e`)
  was reported as an empty success. The bash tool now falls back to the
  process exit code.
- **HTTP status**: the gateway answers an `AgencyError` with a matching
  status (a missing provider key is 401 with code `auth`) instead of 500.
- **Bare `agency`**: the provider line counted known providers as connected.
  It now counts providers with a resolvable key, as `auth list` does.
- **Windows speed**: the keychain no longer spawns PowerShell on every
  command (bare `agency` 1508 ms to 718 ms), and `makeWorktreeReadOnly` no
  longer spawns `attrib` per file (200 files: 16.8 s to 0.12 s).
- **Update check**: every command sent a request to the GitHub releases API
  and could print its notice into `--format json` output. `checkStale` now
  asks at most once a day, prints on stderr, and honours
  `AGENCY_NO_UPDATE_CHECK`.
- **Cancel**: `cancel_turn` and a client disconnect now stop the model request
  at once, in every phase. Before, a response that was already streaming ran
  to its end, and a cancel before the response headers caused a retry. A
  cancelled turn returns `stopReason: "cancelled"` and keeps its finished steps.
- **Worktree race**: two peers started at the same time could fail with
  "worktree creation failed", because two `git worktree add` runs race inside
  git. Worktree changes now run one at a time for each repository.
- **Overflow on llama.cpp servers**: a llama.cpp server reports a full
  context as `exceed_context_size_error` ("exceeds the available context
  size"). The adapter mapped this to `internal`, so compaction never
  started and the run failed. It now maps to `context_overflow`. Measured
  against llama-server b11155.
- **Overflow on an Anthropic-format server**: the same llama.cpp error on
  the `/v1/messages` endpoint was mapped to `internal` by the Anthropic
  adapter. Measured: each later turn of the session then failed. It now
  maps to `context_overflow`, and the same session compacts and continues.
- **Anthropic cache TTL order**: with a long stable system prompt, the
  request had a 1-hour cache mark on the system text after a 5-minute mark
  on the tools. The API documentation requires a 1-hour entry before any
  5-minute entry. The tools now take the 1-hour mark in that case. The
  request shape is tested. The live API result is not confirmed.
- **Thinking on current Claude models**: a thinking level always sent a
  thinking budget. The API documentation says that Claude Opus 4.7 and
  all later models answer 400 to a budget, and that includes the default
  models `claude-opus-5` and `claude-sonnet-5`. These models now get
  adaptive thinking with `output_config.effort` and a thinking summary.
  The 4.5 family and older models keep the budget. The request shape is
  tested. The live API result is not confirmed.
- **Reply cut at the output limit**: a reply that stopped at the output
  limit ended the turn as a normal end, with exit code 0 and a cut answer.
  Now a cut text reply continues: the model is told to go on from the cut,
  at most 3 times in a row, and `-p` prints all the parts. A complete tool
  call in a cut reply runs. A call that the limit cut in the middle gets a
  result that names the limit. A reply that is still cut, or that was cut
  before any text, ends with the turn error `max_tokens` and exit code 1.
  Measured against llama-server with a 40-token and a 60-token limit.
- **Full context window during a reply**: Claude 4.5 and later stop a
  reply with `model_context_window_exceeded` when the window becomes
  full. The adapter read this as a normal end. It is now a
  `context_overflow`. The live API result is not confirmed.
- **Worker model facts**: a worker turn (`spawn`, `dispatch`, a team run)
  did not get the context window or the vision flag of its model. A worker
  on a vision model did not send tool images, and a worker that overflowed
  folded to a 200k window, not to its own. The primary turn, the fallback
  and every worker now take these values from one function.
- **Fallback price**: a turn that ran on `fallback_model` was recorded with
  the name and the price of the primary model, so budgets and the cost
  report were wrong for that turn. The cost records now use the fallback
  model, and the result has `servedBy` with the provider and model that
  gave the answer.
- **Spend of a failed turn**: the tokens of the model requests that
  finished were not counted when the turn then failed or moved to the
  fallback model, so the daily and monthly caps saw less than the real
  spend. The spend ledger, the budgets and the cost meter now count them,
  at the price of the model that used them.
- **Edit rejection text**: when an edit did not find its text, the message
  said that the file had changed since the last read. That was false when
  the model had not read the file. The message now tells the model to read
  the file and to send the exact text.
  When the file has the text with other line breaks, the message shows
  that exact file text. Measured with a real model: it sent two lines as
  one line three times in a row, and the plain rejection did not stop that.
- **Edit across line breaks**: an edit whose old text matches one place in
  the file when a line break counts as a space now applies, if the new
  text has the same number of words. Each word goes in and the file keeps
  its own layout. Other such edits get the rejection with the file text.
- **Empty reply**: a model reply with no text gave exit code 0 and no
  output, and left an empty assistant message in the session. The turn now
  carries the error `empty_response` and the CLI exits with code 1. The
  empty message is not stored, and the Anthropic and Google adapters leave
  out any message that maps to no content.
- **Tool calls on OpenAI-compatible servers**: a server that sent a tool call
  and then finish reason `stop` had its call dropped, and the turn ended
  with no output. A call with no id was dropped too. The adapter now treats
  a response with tool calls as a tool turn and gives an id to a call that
  has none. A call that is still open when the stream ends with no finish
  reason is closed, so its arguments are checked and answered.
- **Tool turn with no call**: a provider that reported a tool stop reason
  with no tool call made the loop send the same request again, up to the
  step limit. Such a reply now ends the turn.
- **Thought signatures across providers**: a session that moved from one
  provider to another (a fallback, or a new `--model`) replayed thought
  signatures to a provider that did not issue them. Each signature now
  records its provider, and an adapter replays only its own.
- **Anthropic thinking budget**: the adapter sent a fixed budget for each
  thinking level. The API takes a budget of 1024 or more that is less than
  `max_tokens`, so level `high` with the default output limit of 8192 was an
  invalid request. The budget is now at most half of `max_tokens`, and the
  request goes out with no thinking when no valid budget fits.
- **Images from tools**: the `read` tool returned an image and said "Attached
  image", but no adapter sent the image to the model. A model whose catalog
  or config entry has `capabilities.vision` now gets it: inside the tool
  result on Anthropic, and in a user message after the tool messages on
  OpenAI-compatible providers. Other models get the text only, as before.
  The Google adapter does not send these images yet.
- **Gemini tool calls**: the Google adapter sent a function response under a
  made-up id as its name, with no call id and no thought signature. The
  Gemini docs say that a response must carry the call's id and its real
  function name, or the model returns an empty reply. The adapter now sends
  all three and keeps the id that the model gives a call. Ids that the
  adapter makes no longer repeat across turns.
- **Gemini usage**: the adapter read the cached token count from a field
  that does not exist and left thinking tokens out of the output count.
- **Anthropic cost with prompt caching**: the Anthropic adapter reported only
  the input tokens that were not cached. The cost formula takes the cached
  part out of the input total, so the uncached part was priced at zero and
  budgets counted too little. The adapter now reports the whole prompt.
- **Unfinished workers**: a `spawn` worker or a `dispatch` peer that stopped
  early (a provider stream that died, or the step limit) returned its partial
  text as a normal result. The result now says "did not finish" with the
  cause, and a `spawn` result is an error result.
- **Step limit**: a headless run that reached the limit of 25 tool steps
  printed nothing and exited with code 0. It now prints `iteration_limit`
  and exits with code 1. The turn result carries the same error.
- **Exit with no output**: the CLI did not wait for its own main call. When
  nothing else held the process open, it exited with code 0 and printed
  nothing. The main call is now awaited.
- **JSON output on failure**: with `--format json`, a run that failed printed
  nothing on stdout. It now prints `{"error": {"code", "message"}}` there,
  and the exit code stays 1. The RPC client now keeps the error code that
  the daemon sends.
- **Two runs on one session**: two sends that ran at the same time on one
  session started from the same point. The history forked and one turn was
  lost. A session now runs one turn at a time, and the second send waits.
- **Summary text**: a compacted session stored the summarizer's own
  instructions at the top of the summary, and the model read "MUST NOT call
  tools" there as a user message. The summary now holds only the transcript.
- **Overflow without a session**: a plain `-p` run and a child agent had no
  compaction, so a full context ended the run. The turn loop now folds its
  own transcript and continues. The limit is one fold for each request, not
  one for each turn. An overflow that cannot be folded now prints its cause;
  before, the CLI exited with code 1 and no message.
- **Overflow in a long turn**: when the context filled in the middle of a
  turn, compaction started from the prompt, so the model lost the steps of
  that turn and ran its tools again. Compaction now starts from the last step.
- **Compaction cut**: compaction could keep a tool result and summarize the
  call that it answers. Providers reject such a request. A call and its
  results now stay together.
- **Fallback restart**: a turn that moved to `fallback_model` started again
  from the prompt, so tools that the first provider had already run ran a
  second time. The fallback now continues from the steps that are complete.
- **Fallback limits**: a fallback request used the output limit, the price
  and the context window of the primary model. A fallback model with a
  smaller output limit could reject the request. It now uses its own values.
- **Fallback keys**: when `fallback_model` named a provider with no key, a
  fallback sent the primary provider's key to that provider. The fallback is
  now skipped and the original error is returned.
- **Worker keys**: a `spawn` worker that named a model on a provider with no
  key kept the parent's key and sent it to that other provider. The worker
  now stays on the parent's provider and model.
- **Compare without a key**: `dispatch_compare` sent a request with an empty
  key to the pinned provider of an agent that had no key. Such an agent now
  runs on the default model when that model's provider has a key, and the
  result names the model that ran.
- **Compaction window**: a session turn compacted against a fixed window of
  200,000 tokens. It now uses the context window of the model in use, so a
  model with a small window is compacted before the request overflows.
- **Resumed output**: `-p` with `--continue` or `--session` printed the replies
  of the earlier turns again before the new reply. It now prints the reply to
  the prompt of this run only.
- **Request errors**: a request with a missing parameter, an unknown id or a
  bad value now fails with the new `invalid_request` code, and the HTTP
  gateway answers 400. Before, these read as `internal` and 500.
- **Update on Windows**: `agency update` and its rollback renamed a file over
  the running executable, which Windows refuses (`EPERM`). The running binary
  now moves aside first. An idle daemon from the old binary exits after the
  swap.
- **Stalled streams**: a provider stream that sent nothing kept the turn
  waiting until a cancel. After 5 minutes of silence the request is now cut. A
  turn with no content yet is tried again; a turn with content ends with a
  network error that names the stall.
- **Daemon lifetime on Windows**: the daemon stopped when the CLI that started
  it exited, so each command started a new daemon. It now outlives the CLI and
  serves later commands until its idle time ends.
- **Config changes**: an idle daemon exits within one second of a change to a
  config file, so the next command loads the new config. Before, a daemon
  that stayed in use never loaded it.
- **Interrupted turns**: a turn that stopped before its tool calls ran (stream
  drop, output limit, cancel) left those calls with no result, and a provider
  rejects every later request on such a session. The loop now answers them
  with an error result. A stream drop reports its cause: `error` in the turn
  result, one line on stderr in the CLI.
- **Failed turns**: a session turn that failed after some tool steps dropped
  those steps, and so did a daemon that stopped during a turn. `session_send`
  now stores each message when the turn produces it, so the next turn sees
  work that is already on disk.
- **RPC on Windows**: a malformed frame destroyed the socket inside its own
  data callback, and Bun crashed with a segmentation fault some time later.
  The destroy now runs after the callback returns.
- **Provider endpoints**: a configured provider's `baseUrl` and `headers` now
  apply to the `anthropic` and `google` families too. Before, a custom
  provider with `family: "anthropic"` sent its key to the vendor host. A
  builtin provider id with a key-only config entry no longer fails with
  "needs a baseUrl".
- **Test isolation**: the suite wrote into the real user data directory.
  `AGENCY_HOME` now roots config, data and cache on every platform, and a
  test preload sets it.
  A `bunfig.toml` in each package loads the same preload, so a run from
  inside a package folder is isolated too. Before, `bun test` in
  `packages/cli` wrote 400 session files into the real data directory.
- **CI triggers**: CI runs on a push to the master branch and on manual
  dispatch only.
- **CI reliability**: `.github/workflows/ci.yml` hardened with cross-platform
  test isolation, deterministic barrier timing in parallel tests, macOS
  tmpdir canonicalization, and PowerShell DPAPI import fix for Windows
  credential encryption.
- **Backlog closes**: 20+ correctness defects across loop, store, providers,
  session isolation, sandbox path traversal, bash timeout races, and
  formatter error propagation.

### Removed

- `packages/tui` (16 modules: renderer, transcript, themes, error-states, connect, models-picker, session-browser, diff-viewer, command-palette, help, keybinds, status, empty, thinking, theme) removed. The repo is now a pure backend (daemon, RPC, HTTP+SSE gateway, tools, MCP/LSP, team dispatch, traces, permissions, plugins, headless CLI). The interactive frontend follows separately. `agency` without arguments prints a health summary (model, connected providers, sessions) and exits 0; use `agency -p "prompt"` for headless or `agency --help` for commands.

### Added

- **`PermissionRequest` hooks**: a command hook that runs when a tool
  call needs an approval, before the user is asked. It can approve
  the call, refuse it, or give no answer. It also runs in a run with
  no person to ask, so a script can decide there. `SubagentStop`
  hooks now get the agent type, and their matcher tests it.
- **The `code` tool on Windows, in a sandbox**: `codeMode: true` runs the script
  in an AppContainer with no capability: no network, no write outside its
  own temporary folder, and of the user's files only the runner. Before,
  Windows had no script sandbox and the tool was not offered.
- **The output of a background hook reaches the model**: the
  `additionalContext` and `systemMessage` of an `async` hook, and the stderr of
  an `asyncRewake` hook on exit code 2, go to the model before its next request.
- **The binary starts about 45 ms faster**: it is compiled to bytecode, so
  each start skips the parse of the bundle. This also counts for each
  command of the Windows sandbox, which starts the binary as its helper.
  Measured on Windows: `agency --version` 233 to 189 ms, a sandboxed
  command 264 to 220 ms (medians of 10). The binary is 9 MB larger (94.7 MB).
- **`if` and background hooks**: a hook with `"if": "Bash(git push *)"`
  runs only for a tool call that matches the rule. Before, `if` was
  dropped, so such a hook ran for every call of the tool. `async` and
  `asyncRewake` hooks run in the background; before, the event waited
  for them and they could block it. 18 of the 54 hooks in the 16 hook
  files of Claude Code plugins on the test PC use one of these fields.
- **`UserPromptExpansion` and `StopFailure` hooks**: the first runs when a
  typed command becomes the prompt and can refuse it, the second when a
  turn ends on a provider error. 15 of the 33 hook events of Claude Code
  now run.
- **Sandbox of the operating system on Windows**: `sandbox.backend: "os"`
  runs each command under a write-restricted token. A command writes
  only in the workspace and in a temporary folder of its own, not in
  `.git\hooks`. A job object ends the command and its children. It needs
  `sandbox.allowNetwork: true` (no network block without administrator
  rights) and PowerShell or `cmd`: Git Bash (MSYS) does not start under
  the token.
- **A background command stays in the sandbox**: with the `os` backend it
  runs in the sandbox, with `docker` it is refused. Before, `background: true`
  ran the command on the host, outside every backend.
- **A daemon that fails at its start gives its reason**: the command
  that started it shows the reason at once. Before, it waited 30 seconds
  and said only that the daemon did not become ready.
- **The model is told the limits of its turn**: the result of a tool
  call says one time when 5 tool steps are left, and one time when
  80 percent of the cost limit of the turn is spent. Before, a turn
  ended at a limit with no warning to the model.
- **`SessionEnd` hook**: runs when a session is deleted. 13 of the 33
  hook events of Claude Code now run.
- **`/compact <session> [provider/model] [instructions]`**: words
  after the session are instructions for this one summary. The
  command also uses the window of the model and `compactionLimit`;
  it used a fixed window of 200000 tokens.
- **A compaction in a turn leaves room for the system prompt and the
  tool list**: their size is taken out of the limit and of the size
  after compaction.
- **A warning for `codeMode: true` with no script sandbox**: the log
  says one time that the `code` tool is not offered.
- **Compaction at a token limit, and inside a turn**: a session is now
  compacted at 220000 tokens when the window of the model is larger
  (`compactionLimit` in the config). Before, a model with a window of
  one million tokens was compacted at 900000. The check also runs
  before each request in a turn. Before, a long turn was compacted
  only after the provider refused a request. A summary now leaves
  more of the newest messages word for word: up to 40 percent of the
  size after compaction, at most 40000 tokens. The numbers are from
  a study of 873 compactions of one developer (LangWatch).
- **A cut command output keeps its end**: a `bash` output above
  30000 bytes kept its start only. It now keeps the start and the
  end, because the error of a build or a test run is at the end.
- **Old tool output is removed before a summary**: a compaction first
  changes each old tool result to one line and keeps the newest
  results. If that is enough, no model writes a summary, and all
  texts stay word for word. The idea is from a study of harness
  design (arXiv 2609.20804), where this order had the lowest cost. One
  live run each on a 12000-token window: the turn after the
  compaction had 4375 input tokens against 10987, with the same
  right answer.
- **`compactionInstructions`**: text in the config for the model that
  writes the summary of a compaction, for example which facts the
  summary must keep. Claude Code and Codex have the same control.
- **`--max-total-cost <usd>` for `workflow run`**: a cost limit for
  the whole workflow. A turn gets what is left of the total, and no
  turn starts when nothing is left. `--max-cost` stays the limit of
  one turn.
- **`code` tool (`codeMode`)**: the model writes one JavaScript script
  that calls the other tools as functions (`await tools.read({...})`),
  also in parallel, and gets back only what the script prints and
  returns. Each inner call meets the same permission rules, schema
  check and hooks as a direct call. A script has at most 120 seconds
  and 100 tool calls. `codeMode: true` runs the script in an OS sandbox
  with no network, no write access and no view of the user's files
  (bubblewrap on Linux, Seatbelt on macOS; on Windows the tool is not
  offered). That sandbox was never run: tests cover its arguments
  only. `codeMode: "host"` runs the script with no isolation: it then
  has the authority of a shell command, asks like one, and the ask
  shows the script. Default: off.

- **`sandbox.backend: "os"`** (not run yet on Linux or macOS): shell
  commands in bubblewrap on Linux and in Seatbelt on macOS. Read-only
  disk, writable workspace, no network unless `sandbox.allowNetwork`.
  Only the arguments and the profile text have tests.
- **`--json-schema <file>`**: with `-p`, the answer is JSON that
  matches a JSON Schema, for scripts and CI. An answer that breaks the
  schema goes back to the model. The `outputSchema` field of
  `run_turn` does the same for an RPC client.
- **`agency review [<ref>]`**: a review of the uncommitted changes, or
  of the changes since a ref, that changes no file. Findings have
  file, line and a case that fails.
- **`--system-prompt` and `--append-system-prompt`**: with `-p`, the
  first replaces the base text of the system prompt for one run, and
  the second adds text after it.
- **Six more hook events of Claude Code**: `PostToolUseFailure`,
  `SubagentStart`, `SubagentStop`, `PreCompact`, `PostCompact` and
  `Notification` (when a turn waits for an approval). A `PreCompact`
  hook can refuse a compaction, and a `SubagentStop` hook can keep a
  worker at work.
- **MCP resources and prompts**: a server that declares resources
  gives the model the `mcp_list_resources` and `mcp_read_resource`
  tools. A prompt of a server is the slash command
  `/mcp__<server>__<prompt>`, and the words after it are its
  arguments. `mcp_status` lists the commands.
- **Deferred MCP tool schemas** (`mcpDeferTools`, default `auto`): with
  more than 10 MCP tools, a request has no schema of an MCP tool. The
  model sees their names in the new `tool_search` tool and loads the
  ones that it needs, which stay for the session. Measured with one
  server of 31 tools, one run each: 8491 input tokens against 20789
  for a task that needs no MCP tool, 13257 against 20982 for a task
  that needs one. `never` gives the old behaviour.
- **Images in MCP results**: an image that an MCP tool returns goes to
  a model with image input as an image. Before, its base64 data was in
  the text of the result. The text now has `[image <mime type>]`.
- **`sandbox.denyEnv`**: a list of environment variables that a shell
  command of the model does not get, for tokens and keys of other
  names than `AGENCY_<ID>_API_KEY`.
- **`agency daemon status` lists the turns that run**, and
  **`agency daemon cancel <turn>`** stops one, so a long run can be seen
  and stopped from another terminal. The `turns_list` RPC gives the
  same list.
- **`agency workflow run <file>`**: runs a JavaScript or TypeScript
  script that starts agent turns with `agent()`, in sequence or with
  `parallel()`, and prints the value that the script returns.
  `--arg key=value` gives arguments to the script.
- **MCP servers of a workspace**: the daemon reads `.mcp.json` in the
  workspace root (the project file of Claude Code) and the files of
  `.agency/mcp/`, only when the workspace is trusted. `${VAR}` and
  `${VAR:-default}` take values from the environment. The user config
  wins on a name. `agency plugin install` writes the MCP servers of a
  plugin to `.agency/mcp/<plugin>.json`: before, it printed them for
  a manual merge.
- **Hooks of a Claude Code plugin**: `agency plugin install` now
  installs the command hooks of a plugin into
  `.agency/hooks/<plugin>.json`, copies the plugin to
  `.agency/plugin-roots/<plugin>/` and points `${CLAUDE_PLUGIN_ROOT}`
  at that copy. The daemon runs the hook files of a workspace only
  when the workspace is trusted. Before, the install only printed a
  list of event names and no hook ran. `agency plugin remove` deletes
  the hook file and the copy.
- **`--max-cost <usd>`**: stops a headless turn when its cost reaches the
  amount. The run prints `budget_exceeded` and exits with code 1.
- **`--format stream-json`**: with `-p`, one JSON line for each event
  of the turn, then the result as the last line.
- **`maxSteps`** in the config: the step limit of a turn when the caller
  sets none.
- **`provider.<id>.requestsPerMinute`**: the request rate of the daemon
  to one provider. The default stays 60.
- **Agent types for `spawn`**: an agent file with a `description` is a
  type that the model can choose with the new `agent` parameter. The
  worker gets the file's prompt, tools and model. An agent file of
  Claude Code works as it is: before, its `name` and `description`
  fields made the file invalid.
- **Session goal**: `--goal "<condition>"` with `--session`, the
  `/goal <session> [condition|clear]` command, and the `goal` field of
  `session_send` give a session a condition that must be true before a
  turn ends. At the end of a turn the model judges the transcript
  against the goal. With the goal not met, the model gets the reason
  and the turn goes on, up to the step limit. A met goal clears itself.
- **Compaction summary by the model**: the model of the session now
  writes the summary of a compacted session, in fixed sections
  (requests and rules, decisions, files, commands, errors, state, next
  step). Before, the summary was the first and the last lines of a
  folded transcript, so tool results and earlier answers were lost. The
  offline summary stays as the fallback when the request fails.
  `/compact` now compacts a session at any size: before, it did nothing
  below 90 percent of a 200k window.
- **Command hooks**: the `hooks` config key runs shell commands on
  `PreToolUse`, `PostToolUse`, `UserPromptSubmit`, `SessionStart` and
  `Stop`, in the hook format of Claude Code settings. Exit code 2 or a
  JSON `decision` of `block` refuses a tool call, refuses a prompt, or
  keeps the turn going with the reason as a message to the model.
  A plugin hook can block too: a handler of `tool.execute.before`,
  `tool.execute.after` or the new `turn.stop` event that returns
  `{ block: "reason" }`. Before, the plugin wrapper swallowed every
  error of a hook, so no plugin could refuse a tool call.
- **Reasoning on OpenAI-compatible servers**: `reasoning_content` in a
  stream (llama.cpp with a reasoning model, DeepSeek) is now reported as
  thinking. Before, it was dropped. It is never sent back to the server.
- `provider.<id>.streamIdleMs`: the longest silence on a response stream
  before the request is cut, for one provider. The default stays 5 minutes.
  A llama.cpp server sends nothing while it reads the prompt. Measured
  against llama-server b11155 on a CPU: with the default, a cold 8.7k-token
  prompt was cut at 300 s and the retry finished from the server's cache;
  with `streamIdleMs: 900000`, a 9.9k-token prompt that took 406 s was not
  cut.
- `--max-steps <n>` sets the tool step limit for one headless run, and
  `session_send` takes `maxToolIterations`. The default stays 25.
- `-p -` reads the prompt from stdin, so a long prompt can come from a pipe
  or a file. An empty stdin is an error.
- `--permission-mode allow-all`: a headless run can allow every tool for one
  run without a config edit. A `deny` entry, the `.env` read block and the
  trust gate still refuse.
- `scripts/e2e-cli.ts`: an offline end-to-end check that drives the real CLI
  (or the compiled binary) through a tool turn and a session resume against a
  local stand-in, once per wire format (OpenAI-compatible, Anthropic, Google).
  CI builds the binary and runs it.
- `scripts/doc-claims.ts` now fails when a `Wired: Yes` row in
  `docs/status.md` names a symbol that the CLI entrypoint and the SDK cannot
  reach.
- Release engineering: `bun build --compile` binary builds with a 100 MB size
  budget check (`scripts/build.ts`, 80 MB was the pre-Bun-1.4 target; 100 MB reflects the actual runtime floor, override with `--max-size-mb`), per-platform signing scripts
  (`scripts/sign.sh` for macOS/Linux, `scripts/sign.ps1` for Windows), a tag-triggered release workflow
  with checksums and SBOM, and fail-closed install scripts for
  macOS/Linux (`scripts/install.sh`) and Windows (`scripts/install.ps1`).
- CycloneDX 1.5 SBOM generation from `bun.lock` (`scripts/sbom.ts`,
  `bun run sbom`), reproducible with `--reproducible`.
- `agency debug` writes a redacted support bundle for issue reports.
- `agency onboard`: first-run flow (connect a provider, pick a default
  model, trust the workspace.
- Documentation: install, configuration, storage, privacy policy, and release
  process under `docs/`, plus this changelog (each doc is verified against the current codebase).
- Perf budgets in CI: `scripts/perf-check.ts` (cold start < 150 ms via `agency --version`, idle RSS < 120 MB, zero-CPU-at-idle) runs as a non-blocking perf job in CI.

## [0.1.0] - 2026-09-01

Initial development release. Foundation through ecosystem, built in phases:

- **Foundation**: Bun workspace, versioned schema with migrations, layered
  config (global/project/env/flags/managed), event bus, structured logging
  with trace IDs, i18n catalog, tri-platform CI.
- **Network + providers**: single HTTP path (proxy, custom CA, timeouts,
  offline), streaming adapters for Anthropic/OpenAI/Google/OpenAI-compatible,
  model registry with models.dev catalog, family presets, scheduler with
  retry/backoff, real tokenizers, cache-breakpoint policy.
- **Auth + guard**: OS keychain storage (DPAPI / Keychain / libsecret /
  encrypted fallback), capability model, policy engine, trust gate, redactor
  chokepoint, sandbox boundary.
- **Daemon + loop**: RPC daemon with version handshake and instance
  lifecycle, agent loop with cancellation and budgets, headless client.
- **Tools + edit engine**: built-ins (read/write/edit/bash/grep/glob/fetch/
  todo, `createBuiltinTools` + plugin-registered tools), hash-anchored edits that refuse rather than misapply, content-
  addressed snapshots with daemon RPC `undo`/`redo`, process manager, formatter hook.
- **Prompt + context + sessions**: fixed-order prompt composition with environment block and system reminders, AGENTS.md
  and rules loading behind the trust gate, compaction both proactive (0.9 trigger ratio, 0.7 target ratio, 20K summary cap) and reactive (compact-and-retry on `CONTEXT_OVERFLOW` with `needsCompaction` + `runSessionTurn` retry),
  append-only JSONL session trees with fork/clone/resume/export, crash recovery, storage layout with `agency where`/`storage`/`prune`.
- **TUI** (`packages/tui`, since removed in Unreleased): differential renderer with degradation modes (no-color, narrow,
  non-TTY, screen-reader), streaming transcript with collapsible thinking,
   model picker with fuzzy search (`Ctrl+L`, ModelPickerStore with favorites/recents), `/connect` flow
  (`tui/connect.ts`, also available as `agency auth login`), session browser, diff
  viewer, command palette (`Ctrl+K`), contextual help (`?`), rebindable keybinds, themes,
  designed empty/error states. The TUI was implemented but not yet launched from the entrypoint; it has been removed in the Unreleased backend-only cut pending the new frontend.
- **Ecosystem + input**: MCP client (stdio + HTTP with headers/timeouts) registering through the
  built-in tool contract (parallel start, `mcp_status` RPC, `mcp_server_down` reminders), minimal LSP client feeding edit verification
  (diagnostics appended to `write`/`edit` results, `lsp_status` RPC), image input across adapters, todo tools, SDK surface.
- **Observability + onboarding**: opt-in telemetry and crash reporting
  (local-only in v1), per-session cost/token accounting with cache-hit-rate
  reporting, first-run onboarding, `agency debug` bundle.

[Unreleased]: https://github.com/AgencyAgents/Agency/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/AgencyAgents/Agency/releases/tag/v0.1.0
