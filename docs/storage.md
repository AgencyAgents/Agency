# Storage

## Paths

Every path is derived from the OS data/config/cache roots plus the workspace identity.

| What | Path | Env override |
|---|---|---|
| Config | `<configDir>/config.jsonc` — `configDir()` | `APPDATA` (win32), `XDG_CONFIG_HOME` (linux), always-profiled on macOS |
| Data dir | `dataDir()` | `LOCALAPPDATA` (win32), `XDG_DATA_HOME` (linux), fixed `~/Library/Application Support/Agency` on macOS |
| Cache dir | `cacheDir()` — `Agency/Cache` (win32), `~/Library/Caches/Agency` (macOS), `~/.cache/agency` (linux) | `LOCALAPPDATA` / `XDG_CACHE_HOME` (macOS has none) |
| Logs dir | `logDir()` = `dataDir()/logs` | same as data dir |
| Sessions | `storagePaths(ws).sessionsDir` = `dataDir()/sessions/<workspaceId>` | `workspaceId` = first 16 hex chars of SHA-256 of `resolve(workspaceRoot)` |
| Snapshots | `storagePaths(ws).snapshotsDir` = `dataDir()/snapshots` | global, content-addressed |
| Catalog cache | `cacheDir()/model-catalog.json` | — |
| Model registry disk cache | `cacheDir()/models-dev-catalog.json` is separate from `model-catalog.json` | — |
| Instance file | `<instanceDir>/<workspaceHash>.json` (daemon port/pid/token) | `instanceDir` defaults to `dataDir()/instances` |
| Trust store | `dataDir()/trust.json` | overridable via daemon `trustStorePath` |
| Telemetry | `dataDir()/telemetry/events.jsonl` | overridable via daemon `telemetryDir` |

`agency where` prints the four primary roots for the current workspace. `agency where --format json` emits the full `StoragePaths` JSON.

## Sessions

- One append-only JSONL file per session: `<sessionsDir>/<sessionId>.jsonl`, one JSON line per `SessionEntry`.
- Forks share the same file (a `branch_summary` entry whose `parentId` points elsewhere); clones copy the file.
- The tree is parentId-linked; `session list` sorts by newest first, `session delete <id>` removes the file (rejects unknown ids).
- Crash recovery: each append is one flushed line; `load()` skips and warns on corrupt lines and preserves valid entries around them.
- Load cache is per-session with a positional tail read; a mid-line crash tail invalidates the cache so a later append cannot merge onto garbage.
- Appends serialize via a per-session `.lock` file (O_EXCL + 10 s stale-break + 5 s deadline).

Inspect with `agency storage` (sizes by `data`/`cache`/`logs`) or `--format json` (`StorageReport`).

## Snapshots (undo/redo)

Content-addressed blobs under `snapshotsDir` via a snapshot journal keyed by `turnId`. `write`/`edit` capture `before` and (after formatter) `afterHash`; `undo` restores the latest unrestored snapshot, `redo` re-applies it. Blobs are `sha/ <h[0:2]>/<h[2:]>`. The journal is in-memory per daemon — undo depth resets on daemon restart. `prune` refcounts both hashes across `<h[0:2]>/<h[2:]>` shards.

Exposed as daemon RPC `undo`/`redo`; the TUI must go through RPC.

## Logs and telemetry

- Daemon structured logs: when `logsDir` is set (production `daemon-entry` passes `logDir()`), a rotating file sink writes JSONL; otherwise the daemon logs to console.
- Telemetry: opt-in (`telemetryEnabled`), local file sink only in v1; crash reports gated by `crashReportsEnabled`. Both write through the same redactor.

## Retention and safe deletion

- `cacheDir` is regenerable (`model-catalog.json`, tokenizer tables, etc.) and always safe to delete.
- `agency storage prune` always clears `cacheDir` and recreates it empty. With `--max-age-days <days>` and/or `--max-total-mb <mb>`, it also deletes session files across every workspace: first by age, then oldest-first until under the size ceiling. No session is pruned without an explicit retention flag.
- Safe to delete manually: `cacheDir`, `logsDir`, individual `<sessionsDir>/*.jsonl` files (loses that session), `snapshots` blobs (breaks undo for affected turns).
- Never safe to delete casually: `dataDir` as a whole, `config.jsonc` (unless you intend to reset config), `instances` while a daemon is running.
