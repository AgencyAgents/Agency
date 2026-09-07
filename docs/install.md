# Install

## Requirements

- Bun 1.4+ (`bun --version`)
- Linux (x64/arm64), macOS (x64/arm64), or Windows (x64). Windows arm64 is not a release target.

## Install script (recommended)

macOS / Linux:

```sh
curl -fsSL https://raw.githubusercontent.com/AgencyAgents/Agency/master/scripts/install.sh | bash
```

Windows (PowerShell):

```powershell
irm https://raw.githubusercontent.com/AgencyAgents/Agency/master/scripts/install.ps1 | iex
```

Both scripts:
1. Resolve the version from `AGENCY_VERSION` or the latest GitHub release (`api.github.com/repos/AgencyAgents/Agency/releases/latest`).
2. Download `agency-<os>-<arch>` (or `.exe` on Windows) and `checksums.txt` from `releases/download/v<version>`.
3. Verify the SHA-256 checksum before writing anything. A missing or mismatched checksum aborts.

Environment overrides:
- `AGENCY_VERSION` — `v0.1.0` or `0.1.0` (default: latest).
- `AGENCY_INSTALL_DIR` — default `~/.local/bin` (macOS/Linux) or `%LOCALAPPDATA%\Programs\agency` (Windows).

After install, ensure the install directory is on `PATH`. The Linux/macOS script prints a hint if it is not; the Windows script appends it to the user `PATH`.

## Manual install

1. Download the asset for your platform from the GitHub release (e.g. `agency-linux-x64`, `agency-darwin-arm64`, `agency-windows-x64.exe`) and `checksums.txt`.
2. Verify: `sha256sum -c --strict checksums.txt` (check that your asset's line says `OK`; or compare `sha256sum agency-*` / `Get-FileHash` against the entry).
3. Place the binary on `PATH` and make it executable (`chmod +x` on Unix).

## Updating and rollback

Re-run the install script with `AGENCY_VERSION` pinned to the desired tag. There is no in-place updater; every install is a fresh download verified against `checksums.txt`.

## Building from source

```sh
bun install
bun run build:bin        # writes dist/agency-<os>-<arch>[.exe], 100 MB budget
bun scripts/build.ts --targets bun-linux-x64,bun-darwin-arm64 --version 0.1.0 --outdir dist
```

See [Release process](release.md) for budgets, signing, and SBOM.
