# Changelog

All notable changes to Agency are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); the project does not
yet guarantee a stable versioning cadence, but versions are SemVer.

## [Unreleased]

### Added

- Release engineering: `bun build --compile` binary builds with an 80 MB size
  budget check (`scripts/build.ts`), per-platform signing scripts
  (`scripts/sign.sh`, `scripts/sign.ps1`), a tag-triggered release workflow
  with checksums and SBOM, and fail-closed install scripts for
  macOS/Linux (`scripts/install.sh`) and Windows (`scripts/install.ps1`).
- CycloneDX 1.5 SBOM generation from `bun.lock` (`scripts/sbom.ts`,
  `bun run sbom`), reproducible with `--reproducible`.
- `agency debug` writes a redacted support bundle for issue reports.
- `agency onboard`: first-run flow — connect a provider, pick a default
  model, trust the workspace.
- Documentation: install, configuration, storage, privacy policy, and release
  process under `docs/`, plus this changelog.

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
  todo), hash-anchored edits that refuse rather than misapply, content-
  addressed snapshots, process manager, formatter hook.
- **Prompt + context + sessions**: fixed-order prompt composition, AGENTS.md
  and rules loading behind the trust gate, compaction both directions,
  append-only JSONL session trees with fork/clone/resume/export, crash
  recovery, storage layout with `agency where`/`storage`/`prune`.
- **TUI**: differential renderer with degradation modes (no-color, narrow,
  non-TTY, screen-reader), streaming transcript with collapsible thinking,
  `/models` picker with fuzzy search, `/connect` flow, session browser, diff
  viewer, command palette, contextual help, rebindable keybinds, themes,
  designed empty/error states.
- **Ecosystem + input**: MCP client (stdio + HTTP) registering through the
  built-in tool contract, minimal LSP client feeding edit verification,
  image input across adapters, todo tools, SDK surface.
- **Observability + onboarding**: opt-in telemetry and crash reporting
  (local-only in v1), per-session cost/token accounting with cache-hit-rate
  reporting, first-run onboarding, `agency debug` bundle.

[Unreleased]: https://github.com/Pixeless001/Agency/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/Pixeless001/Agency/releases/tag/v0.1.0
