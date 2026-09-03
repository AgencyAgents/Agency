# Agency

A headless backend coding harness: daemon, RPC, HTTP+SSE gateway, real provider
support, tools, MCP/LSP, swarm, traces, permissions, and a headless CLI.
The interactive frontend is not included in this build — it follows separately.
Built for Windows, macOS, and Linux with equal standing.

```
agency -p "prompt"   # run one headless turn
agency --help        # commands: where, storage, session, auth, onboard, debug
```

## Install

macOS / Linux:

```sh
curl -fsSL https://raw.githubusercontent.com/Pixeless001/Agency/master/scripts/install.sh | bash
```

Windows (PowerShell):

```powershell
irm https://raw.githubusercontent.com/Pixeless001/Agency/master/scripts/install.ps1 | iex
```

Both verify the download's SHA-256 checksum before installing anything. See
[docs/install.md](docs/install.md) for manual installs, platforms, and
rollback.

## Getting started

1. `agency onboard` to add a provider API key (stored in your OS keychain) and pick a default model, or `agency auth login <provider>` for a single provider.
2. Trust the workspace when prompted.
3. Run headless: `agency -p "your prompt"` or `agency -p "prompt" --session <id>` / `--continue` for session-backed turns.

## What it does

- **Real edits, safely**: hash-anchored search/replace that refuses rather
  than misapplies, daemon-owned content-addressed snapshots for file undo/redo (`undo`/`redo` RPC over the snapshot journal; redo keeps `afterHash`), formatter hook.
- **Sessions that survive**: append-only JSONL trees with fork/clone/resume,
  crash recovery, proactive and reactive (compact-and-retry) compaction that preserves todos.
- **Any provider**: Anthropic, OpenAI, Google, and any OpenAI-compatible
  endpoint (self-hosted, gateways, corporate proxies) via config and `provider`/`model` flags.
- **Ecosystem tools**: MCP servers (stdio and HTTP with `headers`/`timeoutMs`) register through the same tool contract as
  built-ins (parallel start, `mcp_status` RPC, `mcp_server_down` system reminder); a minimal LSP client feeds edit verification (diagnostics appended after `write`/`edit`).
- **Your machine stays yours**: keys in the OS keychain, secrets redacted at
  one chokepoint, telemetry and crash reports off by default and local-only. See
  [docs/privacy.md](docs/privacy.md).

> **Status note**: `agency` without arguments prints a notice that the interactive client is not included in this build. Use `agency -p "<prompt>"` for headless turns or `agency --help` for commands. The daemon RPC and HTTP+SSE gateway are the primary interfaces today. There is no desktop app; any mention of one is planned, not shipped. The `packages/tui` frontend package has been removed pending the new frontend.

## Documentation

| Doc | Contents |
|---|---|
| [Install](docs/install.md) | Platforms, verification, updating |
| [Configuration](docs/configuration.md) | Layers, providers, MCP, LSP |
| [Storage](docs/storage.md) | Paths, what's safe to delete, retention |
| [Privacy](docs/privacy.md) | Data handling, telemetry, debug bundles |
| [Release process](docs/release.md) | Builds, signing, SBOM, verification |
| [Changelog](CHANGELOG.md) | What changed, per release |

## Development

```sh
bun install
bun run lint          # biome
bun run typecheck     # tsc project references + test references
bun test              # bun test runner
bun run build:bin     # compile agency binary (100 MB budget; override with --max-size-mb)
bun run sbom          # CycloneDX 1.5 SBOM from bun.lock
```

Requires [Bun](https://bun.sh) 1.4+. CI runs lint, typecheck, and tests on
all three platforms for every pull request; a non-blocking `perf` job runs `scripts/perf-check.ts` when present.

## License

[MIT](LICENSE)
