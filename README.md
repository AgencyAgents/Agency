# Agency

A production coding harness for the terminal: one agent, one conversation,
real provider support, a custom TUI, headless mode, and MCP tool consumption.
Built for Windows, macOS, and Linux with equal standing.

```
agency          # work in your project, in the terminal
agency --help   # commands: where, storage, session, auth, onboard, debug
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

1. `agency` in a project directory; trust it when prompted.
2. `/connect` to add a provider API key (stored in your OS keychain).
3. Work. `Ctrl+K` opens the command palette, `?` shows panel shortcuts,
   `/models` switches models mid-session, `Ctrl+T` collapses thinking.

## What it does

- **Real edits, safely**: hash-anchored search/replace that refuses rather
  than misapplies, content-addressed snapshots for file undo, formatter hook.
- **Sessions that survive**: append-only JSONL trees with fork/clone/resume,
  crash recovery, compaction that preserves todos.
- **Any provider**: Anthropic, OpenAI, Google, and any OpenAI-compatible
  endpoint (self-hosted, gateways, corporate proxies) via config.
- **Ecosystem tools**: MCP servers register through the same contract as
  built-ins; a minimal LSP client feeds edit verification.
- **Honest degradation**: no-color, 80-column, non-TTY, and screen-reader
  modes are part of the renderer core, not an afterthought.
- **Your machine stays yours**: keys in the OS keychain, secrets redacted at
  one chokepoint, telemetry off by default and local-only. See
  [docs/privacy.md](docs/privacy.md).

## Documentation

| Doc | Contents |
|---|---|
| [Install](docs/install.md) | Platforms, verification, updating |
| [Configuration](docs/configuration.md) | Layers, providers, MCP, keybinds, themes |
| [Storage](docs/storage.md) | Paths, what's safe to delete, retention |
| [Privacy](docs/privacy.md) | Data handling, telemetry, debug bundles |
| [Release process](docs/release.md) | Builds, signing, SBOM, verification |
| [Changelog](CHANGELOG.md) | What changed, per release |

## Development

```sh
bun install
bun run lint          # biome
bun run typecheck     # tsc project references
bun test              # bun test runner
bun run build:bin     # compile the agency binary (size-budgeted)
bun run sbom          # CycloneDX SBOM from bun.lock
```

Requires [Bun](https://bun.sh) 1.4+. CI runs lint, typecheck, and tests on
all three platforms for every pull request.

## License

[MIT](LICENSE)
