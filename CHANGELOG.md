# Changelog

All notable changes to Agency are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); the project does not
yet guarantee a stable versioning cadence, but versions are SemVer.

## [Unreleased]

### Changed

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
