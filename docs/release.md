# Release process

## Versioning

`package.json#version` is the source of truth (`0.1.0` today). Git tags are `v<version>`. The binary inlines `process.env.AGENCY_VERSION` at compile time via `--define` in `scripts/build.ts`; running from source falls back to `package.json`.

Direction follows `CHANGELOG.md` (Keep a Changelog 1.1.0, SemVer intent but no stable cadence yet).

## Build

```sh
bun install --frozen-lockfile
bun run lint
bun run typecheck
bun run typecheck:test
bun test

bun scripts/build.ts --targets bun-linux-x64,bun-darwin-arm64 --version 0.1.0 --outdir dist
bun scripts/build.ts --max-size-mb 100        # default budget: 100 MB (Bun ~90 MB runtime floor on Windows + ~1 MB app)
bun scripts/sbom.ts --out dist/agency.cdx.json
bun scripts/sbom.ts --reproducible            # deterministic SBOM (no timestamp, name-based serial)
```

`scripts/build.ts` compiles `packages/cli/src/entrypoint.ts` with `bun build --compile --minify --sourcemap=none` per target. Targets map to artifact names in `TARGETS`:

- `bun-linux-x64` -> `agency-linux-x64`
- `bun-linux-arm64` -> `agency-linux-arm64`
- `bun-darwin-x64` -> `agency-darwin-x64`
- `bun-darwin-arm64` -> `agency-darwin-arm64`
- `bun-windows-x64` -> `agency-windows-x64.exe`

A build fails if any artifact exceeds `maxSizeMb` (default 100). The 100 MB value sits just above Bun 1.4's Windows runtime floor; it exists to catch regressions.

Other scripts: `scripts/perf-check.ts` — perf budgets checked in CI (see below).

## Signing

`scripts/sign.sh` (macOS/Linux) and `scripts/sign.ps1` (Windows) are invoked by the release workflow when the matching secret is present:

- macOS: `MACOS_SIGN_IDENTITY`, `MACOS_NOTARY_PROFILE`
- Windows: `WINDOWS_SIGN_THUMBPRINT`
- Linux: `LINUX_SIGN_KEY` (written to `signing.key`, used with `scripts/sign.sh --os linux --key`)

Each signs every `dist/agency-*` artifact for its platform. Missing secrets skip signing without failing the build.

## SBOM

`scripts/sbom.ts` produces CycloneDX 1.5 (`bomFormat: CycloneDX`) from `bun.lock` (parsed as JSONC). Components cover every non-workspace package (with `sha512` integrity from the lockfile) plus workspace packages at the release version. The `bom-ref` is `pkg:npm/<name>@<version>` (`@` scopes percent-encoded). With `--reproducible`, `metadata.timestamp` is omitted and `serialNumber` is a deterministic UUIDv5 over the document content.

## CI

- `CI` (`.github/workflows/ci.yml`): matrix `ubuntu/macos/windows`, Bun 1.4.0, steps `lint` / `typecheck` / `typecheck:test` / `test` (20 min timeout). Branch+PR trigger, stale-run cancellation.
- `Perf` budgets: non-blocking CI job runs `scripts/perf-check.ts` (cold start, idle RSS, zero-CPU-at-idle; single sample, generous thresholds; skips when the binary is absent).
- `Release` (`.github/workflows/release.yml`): triggered on `v*` tags and `workflow_dispatch` (`dry_run` flag). Matrix builds on three runners for the five targets, then lint/typecheck/test, derives `VERSION` from the tag or `package.json`, `bun scripts/build.ts`, per-platform signing (conditional on secrets), and upload of `dist/agency-*` artifacts. A `sbom` job builds `dist/agency.cdx.json` in parallel. The `release` job (only on tag push) downloads and merges artifacts, runs `sha256sum agency-* agency.cdx.json > checksums.txt`, and publishes `gh release create` with `agency-*`, `checksums.txt`, and `agency.cdx.json`.

## Install verification

Both `scripts/install.sh` (macOS/Linux, `sha256sum -c --strict`) and `scripts/install.ps1` (Windows, `Get-FileHash`) download `checksums.txt` alongside the asset and fail closed on a missing or mismatched entry. `AGENCY_VERSION` and `AGENCY_INSTALL_DIR` override the version and destination.

## What to check before tagging

1. `CHANGELOG.md` updated under `[Unreleased]` and the new version section.
2. `bun run lint && bun run typecheck && bun test` green on all platforms (allowlisted catalog/grep flakes are documented in `learnings.md`).
3. `bun scripts/build.ts` within budget and `bun scripts/sbom.ts --reproducible` byte-stable.
4. `scripts/perf-check.ts` within budget locally (or noted as non-blocking in CI).
