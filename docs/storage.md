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

### JSONL as primary store

Append-only JSONL is the sole persistence format for sessions — there is no SQLite, no separate database, and no secondary index. Every session is one `<sessionId>.jsonl` file where each line is a complete `SessionEntry` JSON object. This design is intentional:

- **Atomic appends**: Each line is flushed independently; a crash at any point loses at most one in-flight entry. `load()` skips and warns on corrupt lines and preserves valid entries around them.
- **No write amplification**: Appending a line is a single `write()` syscall. No B-tree rebalancing, WAL flushes, or page compaction.
- **Trivially forkable**: A branch is just a `branch_summary` entry pointing to a `parentId`; clones copy the file. The tree is parentId-linked, not schema-enforced.
- **Human-readable**: Any line is inspectable with `cat`, `head`, `grep`, or `jq` without tooling.
- **Crash recovery**: A per-session `.lock` file (O_EXCL + 10 s stale-break + 5 s deadline) serializes appends. The load cache uses a positional tail read; a mid-line crash tail invalidates the cache so a later append cannot merge onto garbage.

### Sync-events export (SSE replay)

The HTTP gateway exposes `GET /sync-events?sessionId=<id>` for durable event replay over SSE. This is an **additive export** — it reads from the same JSONL files, never writes to them.

- **Endpoint**: `GET /sync-events?sessionId=<id>` (requires `Authorization: Bearer <token>` or `?token=<token>` when the daemon is authenticated).
- **Response**: `text/event-stream`. Each session entry is streamed as an `event: sync-entry` frame with the entry JSON as `data`. A final `event: sync-complete` frame signals the end of replay with a `{ count }` payload.
- **Store interface**: The gateway depends on a minimal `SessionStoreLike` interface (only `load(sessionId)`), keeping it decoupled from the full `SessionStore` class in `@agency/core`.
- **No persistence**: The endpoint is a read-only projector over JSONL. It does not create snapshots, maintain offsets, or track which events a client has already seen — clients reconnect and replay from the beginning.
- **Error codes**: `400` (missing `sessionId`), `404` (session not found), `501` (no store configured on gateway), `405` (wrong method), `401` (unauthorized).

This endpoint is designed for frontends and external consumers that need to reconstruct session state without direct filesystem access to the JSONL files.

## Snapshots (undo/redo)

Content-addressed blobs under `snapshotsDir` via a snapshot journal keyed by `turnId`. `write`/`edit` capture `before` and (after formatter) `afterHash`; `undo` restores the latest unrestored snapshot, `redo` re-applies it. Blobs are `sha/ <h[0:2]>/<h[2:]>`. The journal is durable: one `journals/<sessionId>.journal.jsonl` file per session under `snapshotsDir`, loaded on boot, so undo depth survives daemon restarts. `prune` refcounts both hashes across `<h[0:2]>/<h[2:]>` shards, counting sibling sessions' journals as references so one session's prune never orphans another's undo history.

Exposed as daemon RPC `undo`/`redo`; clients (including the future frontend) go through RPC.

## Logs and telemetry

- Daemon structured logs: when `logsDir` is set (production `daemon-entry` passes `logDir()`), a rotating file sink writes JSONL; otherwise the daemon logs to console.
- Telemetry: opt-in (`telemetryEnabled`), local file sink only in v1; crash reports gated by `crashReportsEnabled`. Both write through the same redactor.

## Design rationale: JSONL vs SQLite

Agency uses append-only JSONL as its primary session store rather than SQLite (which opencode uses). This is a deliberate tradeoff:

| Concern | JSONL (Agency) | SQLite (opencode) |
|---|---|---|
| **Write model** | Append-only — one `write()` syscall per entry, no WAL, no B-tree rebalancing | Transactional — BEGIN/COMMIT, WAL flushes, page writes |
| **Read model** | Full-file parse into memory; positional tail-read cache for incremental loads | Indexed queries — single-row lookups without loading the full dataset |
| **Crash safety** | At most one in-flight entry lost per crash; corrupt lines are skipped and warned | ACID — committed transactions survive crashes atomically |
| **Fork/clone** | File copy or parentId link — zero schema awareness needed | Row copy or parent-pointer query |
| **Human access** | `cat`, `grep`, `jq`, `head` — any line is plain JSON | Requires `sqlite3` CLI or tooling |
| **Compaction** | Proactive (tokenizer-threshold) and reactive (compact-and-retry) rewrite of the JSONL file, preserving todos | VACUUM or DELETE + re-INSERT |
| **Export** | `/sync-events` SSE endpoint streams entries as-is; no schema mapping needed | Requires a query layer or migration script |
| **Schema evolution** | Unknown entry types pass through unchanged (R5: never dropped) | Requires ALTER TABLE or migration framework |
| **Queryability** | No ad-hoc queries — must load and filter in code | Full SQL — `SELECT`, `JOIN`, `WHERE`, `GROUP BY` |

**Why JSONL won for Agency:**

1. **Session access is always full-session**: Every consumer (compaction, projector, sync-events, undo journal) reads the entire session. There is no use case that benefits from single-row indexed lookup. SQLite's query engine adds complexity without serving any actual query pattern.
2. **Append-only matches the write pattern**: Sessions grow by appending entries. They are never updated in place, never deleted individually, and never randomly inserted. JSONL's append model is a direct fit; SQLite's transactional model is over-engineered for this workload.
3. **Fork/clone is free**: Branching a session is a parentId pointer — no schema, no migration, no foreign key. Cloning is a file copy. Both are O(1) operations that SQLite would require multiple queries to represent.
4. **Zero dependency**: JSONL uses only `fs.appendFile` and `fs.readFileSync` — no native bindings, no VFS, no build-time C dependency. This keeps the binary small and the build cross-platform.
5. **Human debuggable**: Operators can inspect any session file with standard Unix tools without installing any database client.

**When SQLite would make sense** (and why Agency doesn't need it today):

- Ad-hoc cross-session queries ("find all sessions where model=X")
- Concurrent readers with different access patterns
- Dataset larger than available RAM
- Partial updates to individual entries

None of these apply to Agency's current session workload. If they emerge, the `/sync-events` export provides a clean integration point for an external SQLite consumer without changing the primary store.

## Retention and safe deletion

- `cacheDir` is regenerable (`model-catalog.json`, tokenizer tables, etc.) and always safe to delete.
- `agency storage prune` always clears `cacheDir` and recreates it empty. With `--max-age-days <days>` and/or `--max-total-mb <mb>`, it also deletes session files across every workspace: first by age (sessions older than `maxAgeDays`), then oldest-first until under the size ceiling (`maxTotalBytes`). No session is pruned without an explicit retention flag.
- Sidecar files (`.trace.jsonl` traces and `.cassette.json` cassettes) are removed alongside their session `.jsonl` when pruning.
- Safe to delete manually: `cacheDir`, `logsDir`, individual `<sessionsDir>/*.jsonl` files (loses that session), `snapshots` blobs (breaks undo for affected turns).
- Never safe to delete casually: `dataDir` as a whole, `config.jsonc` (unless you intend to reset config), `instances` while a daemon is running.

### Retention knobs

| Flag | Type | Behavior |
|---|---|---|
| `--max-age-days <days>` | `RetentionPolicy.maxAgeDays` | Deletes every session file whose last modification time is older than `<days>`. Applied first. |
| `--max-total-mb <mb>` | `RetentionPolicy.maxTotalBytes` | After age-based pruning, if total session size still exceeds `<mb>`, deletes oldest sessions first until under the limit. |
| Neither | — | Only `cacheDir` is cleared; no session files are touched. |

Both flags are safe to combine: age pruning runs first, then size pruning on the survivors. The `pruneSessions()` implementation in `@agency/core` walks every workspace's session directory, collects all `.jsonl` files (excluding `.trace.jsonl`), and applies the policy deterministically.
