# Changelog

All notable changes to Agency are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); the project does not
yet guarantee a stable versioning cadence, but versions are SemVer.

## [Unreleased]

### Changed

- **Dispatch path**: `packages/cli/src/daemon.ts` runs delegation inline:
  `dispatch` tool with depth-1 nesting block, per-agent and team
  budget caps, cost forecast with approval gate, and concurrent peer turns
  with lean briefs (`packages/core/src/team/parallel.ts`).
  `dispatch_compare` fans one prompt out to several handles via
  `spawnParallel`. A lone `@handle` mention routes the turn to that
  agent's provider, model, and effort (`parseHandles` at daemon.ts:1872).
  `planDispatchBatch` in `packages/core/src/team/dispatch-core.ts`
  exists with 7 skip codes but has no runtime caller; the daemon
  reimplements the unknown-handle and budget skips inline.
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
  researcher, and code-reviewer, all pinned to anthropic/claude-sonnet-5.
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
  tool call, improving error attribution in swarm results.
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

- **CI reliability**: `.github/workflows/ci.yml` hardened with cross-platform
  test isolation, deterministic barrier timing in parallel tests, macOS
  tmpdir canonicalization, and PowerShell DPAPI import fix for Windows
  credential encryption.
- **Backlog closes**: 20+ correctness defects across loop, store, providers,
  session isolation, sandbox path traversal, bash timeout races, and
  formatter error propagation.

### Removed

- `packages/tui` (16 modules: renderer, transcript, themes, error-states, connect, models-picker, session-browser, diff-viewer, command-palette, help, keybinds, status, empty, thinking, theme) removed. The repo is now a pure backend (daemon, RPC, HTTP+SSE gateway, tools, MCP/LSP, swarm, traces, permissions, plugins, headless CLI). The interactive frontend follows separately. `agency` without arguments now exits 1 with an honest notice; use `agency -p "prompt"` for headless or `agency --help` for commands.

### Added

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

[Unreleased]: https://github.com/Pixeless001/Agency/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/Pixeless001/Agency/releases/tag/v0.1.0
