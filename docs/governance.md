# Governance & Versioning

## Versioned surfaces

| Surface | Constant | Current |
|---|---|---|
| Config schema | `CONFIG_SCHEMA_VERSION` in `packages/core/src/config/schema.ts` | 2 |
| Session format | `SESSION_SCHEMA_VERSION` in `packages/core/src/sessions/entry.ts` | 2 |
| RPC protocol | `PROTOCOL_VERSION` in `packages/rpc/src/protocol.ts` | 2 |
| SDK types | exported from `packages/sdk/src/index.ts` | 0.1.0 (package version) |

## Bump rules

- **Major**: wire-incompatible change (session entry shape, RPC message semantics, config key removal/rename)
- **Minor**: additive change (new optional config key, new entry type with passthrough, new RPC method)
- **Patch**: bug fix with no schema/protocol change

Config migrations live in `configMigrations`; session entries with unknown `type` pass through (R5); RPC additions are additive (new method or field) and do not bump `PROTOCOL_VERSION`.

## Deprecation policy

One minor-version warning before removal. Deprecated keys/methods log a warning and remain functional for at least one minor release. Removal requires a major bump and a `CHANGELOG.md` entry.

## Release process

See `docs/release.md` for signing, SBOM, and verification.

## Session title entry

`session_title` (type `session_title`, field `title: string`) is stored via the same R5 passthrough — old readers ignore it.

## OAuth

OAuth tokens stored as `{type:"oauth", accessToken, refreshToken, expiresAt}` in keychain; never logged.

## Update verification

`agency update` verifies the ed25519 signature (`verifySignature` over the `.sig` sidecar or the inline field in the signed checksum manifest) before the SHA-256 checksum, backs up the running binary, and supports rollback. Releases publish the signature sidecars plus the signed manifest; see `docs/release.md`.

## Fallback

`fallback_model` (string `provider/model`) in config; on provider-down (retryable exhausted) the daemon retries once on the fallback and emits a `fallback` event.

## Serve threat model

`agency serve` (via `runServe`) binds the daemon loopback-only (`127.0.0.1` in `startHttpGateway`) with the same handler table and token on TCP and HTTP. Assumptions and controls:

- Loopback only: no remote attacker in scope. A `serve` deployment exposed beyond loopback needs its own boundary (reverse proxy, firewall); that setup is not covered here.
- Auth: the `HttpGatewayOptions` token is a bootstrap credential sent only as `Authorization: Bearer`. Query-string bearers are refused; the token mints short-lived scoped tokens via `MintedTokenStore`, checked per endpoint by `scopeGrants`. With no token configured the gateway accepts anonymous callers, so set one on any shared machine.
- Origin: CORS echoes `allowedOrigins` only; empty means none. `/health` stays open by design.
- Abuse: POST `/rpc` and `/auth/mint` share a fixed-window limit (`RPC_RATE_LIMIT_MAX` requests per `RPC_RATE_LIMIT_WINDOW_MS`, refused as 429 `RATE_LIMITED` with `Retry-After`) and a body cap (`RPC_MAX_BODY_BYTES`, refused as 413 `BODY_TOO_LARGE`).
- Visibility: every completed `write`, `edit`, or `bash` call emits a structured `tool.audit` event (the `MUTATING_TOOLS` set) carrying tool, target, outcome, session, turn, and agent.
