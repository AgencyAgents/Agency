# Install

## Requirements

- Bun 1.4+ (`bun --version`)
- Linux (x64/arm64), macOS (x64/arm64), or Windows (x64). Windows arm64 is not a release target.

## Install script (recommended)

macOS / Linux:

```sh
curl -fsSL https://raw.githubusercontent.com/EndeavorAI/Agency/master/scripts/install.sh | bash
```

Windows (PowerShell):

```powershell
irm https://raw.githubusercontent.com/EndeavorAI/Agency/master/scripts/install.ps1 | iex
```

Both scripts:
1. Resolve the version from `AGENCY_VERSION` or the latest GitHub release (`api.github.com/repos/EndeavorAI/Agency/releases/latest`).
2. Download `agency-<os>-<arch>` (or `.exe` on Windows) and `checksums.txt` from `releases/download/v<version>`.
3. Verify the SHA-256 checksum before writing anything. A missing or mismatched checksum aborts.

Environment overrides:
- `AGENCY_VERSION` — `v0.1.0` or `0.1.0` (default: latest).
- `AGENCY_INSTALL_DIR` — default `~/.local/bin` (macOS/Linux) or `%LOCALAPPDATA%\Programs\agency` (Windows).
- `AGENCY_NO_MODIFY_PATH` — Windows only. Set to `1` to leave the user `PATH` as it is.

After install, ensure the install directory is on `PATH`. The Linux/macOS script prints a hint if it is not; the Windows script appends it to the user `PATH`, unless `AGENCY_NO_MODIFY_PATH` is `1`.

## Manual install

1. Download the asset for your platform from the GitHub release (e.g. `agency-linux-x64`, `agency-darwin-arm64`, `agency-windows-x64.exe`) and `checksums.txt`.
2. Verify: `sha256sum -c --strict checksums.txt` (check that your asset's line says `OK`; or compare `sha256sum agency-*` / `Get-FileHash` against the entry).
3. Place the binary on `PATH` and make it executable (`chmod +x` on Unix).

## Updating and rollback

`agency update` downloads the latest release and verifies its signature and checksum. It then moves the running binary to `<binary>.previous` and puts the new binary in its place. `agency update --rollback` puts the previous binary back. An idle daemon from the old binary exits within one second; a daemon in a turn finishes that turn first.

To install a specific version, re-run the install script with `AGENCY_VERSION` pinned to the desired tag.

## Building from source

```sh
bun install
bun run build:bin        # writes dist/agency-<os>-<arch>[.exe], 100 MB budget
bun scripts/build.ts --targets bun-linux-x64,bun-darwin-arm64 --version 0.1.0 --outdir dist
```

See [Release process](release.md) for budgets, signing, and SBOM.
