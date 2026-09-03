# Privacy

## Summary

- Telemetry and crash reporting are **off by default**. Nothing is recorded or sent until `telemetryEnabled` / `crashReportsEnabled` are explicitly enabled.
- Provider API keys are stored in the OS keychain, not in files.
- Every log and bundle passes through a single redactor chokepoint before it is written.
- There is no desktop app and no cloud service; in v1 telemetry is local-only.

## Data handling

### What is stored where

| Data | Location | Notes |
|---|---|---|
| Sessions | `dataDir()/sessions/<ws>/<id>.jsonl` | Append-only JSONL; fork/clone/resume preserved. Deleted only by `session delete` or `storage prune` with retention |
| Snapshots | `dataDir()/snapshots` | Content-addressed file states for undo/redo |
| Config | `<configDir>/config.jsonc` | May contain low-precedence `provider.<id>.apiKey` (prefer keychain) |
| Trust decisions | `dataDir()/trust.json` | Workspace trust approvals |
| Logs | `dataDir()/logs` (rotating JSONL) | Structured logs with trace IDs; redacted |
| Cache | `cacheDir()` | Model catalog, tokenizer tables — regenerable |
| Telemetry | `dataDir()/telemetry/events.jsonl` | Only when `telemetryEnabled` |
| Keys | OS keychain | See below |

### Keys

`@agency/providers` resolves keys per turn in this order:

1. Declared `provider.<id>.env` entries (first present env var wins)
2. `AGENCY_<PROVIDER>_API_KEY` (e.g. `AGENCY_ANTHROPIC_API_KEY`)
3. OS keychain (`agency auth login <provider>` stores via `keychain.set`)
4. `provider.<id>.apiKey` from config (lowest precedence, local dev only)

Keychain backends: DPAPI on Windows, Keychain on macOS, libsecret where available on Linux, and an encrypted file fallback elsewhere. Legacy Windows DPAPI format (hex `76492d11...` prefix) is detected and migrated to the current format. The daemon resolves keys itself via `getKeychain()` — headless `-p` validates locally for a fast failure but does not send the key over RPC. Keys are registered with `Redactor` so every log line scrubs them.

Legacy DPAPI detection: a stale hex-format key that fails to decrypt throws an actionable "re-run `agency auth login`" error rather than returning `undefined` silently.

### Telemetry and crash reports

- `telemetryEnabled` (`AGENCY_TELEMETRY`, `1`/`true`/`yes`/`on`) — when off (the default), `Telemetry.record` is a no-op and `events.jsonl` is not written.
- `crashReportsEnabled` (`AGENCY_CRASH_REPORTS`, same truthy set) — gates crash payloads fed to `agency debug`.
- Both use `createFileTelemetrySink` (local file only). There is no remote endpoint in v1.
- Events checked in code: `turn_complete` (provider, stopReason, input/output/cached tokens) and crash reports from `run_turn` failures. Each record passes through `Redactor`.

### Redaction chokepoint

One `Redactor` owns every secret. `registerSecret` is called for config `apiKey` values and for `AGENCY_*_API_KEY` env entries; the daemon also registers the resolved per-turn key. `Logger` and `Telemetry` both scrub through it. `redactValue` is depth-capped (8) and cycle-safe (path-scoped set, DAG shared nodes are not treated as cycles). The debug bundle (`agency debug`) is built from the same redacted sources.

### Network

Provider requests go through a single `HttpClient` (`@agency/net`) with proxy, custom CA (`resolveCa` with a module-level file-content cache), timeouts, and offline-failure handling. No other network call is made during a turn except the provider request and optional `mcpServers` HTTP transports.

### What is never collected

Third-party analytics, automatic key upload, or silent catalog reporting. MCP/LSP servers you configure run as child processes you authorized; Agency does not phone home about them.

## Controlling your data

- See where everything lives: `agency where` (and `--format json`).
- See sizes: `agency storage`.
- Clear regenerable state: `agency storage prune` (cache only) or with `--max-age-days` / `--max-total-mb` for session retention.
- Delete a session: `agency session delete <id>`.
- Inspect config: `<configDir>/config.jsonc` (JSONC). Remove `telemetryEnabled` / `crashReportsEnabled` or set them `false` to disable.

## Debug bundles

`agency debug` writes a redacted support bundle (paths, versions, recent logs) suitable for issue reports. Review the bundle before sharing — even redacted, it contains project-local context you may wish to trim.
