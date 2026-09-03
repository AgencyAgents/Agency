# Governance & Versioning

## Versioned surfaces

| Surface | Constant | Current |
|---|---|---|
| Config schema | `CONFIG_SCHEMA_VERSION` in `packages/core/src/config/schema.ts` | 2 |
| Session format | `SESSION_SCHEMA_VERSION` in `packages/core/src/sessions/entry.ts` | 2 |
| RPC protocol | `PROTOCOL_VERSION` in `packages/rpc/src/protocol.ts` | 1 |
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

`agency update` verifies SHA-256 against the release `checksums.txt`; ed25519 signature verification is a documented TODO until a signing key is distributed.

## Fallback

`fallback_model` (string `provider/model`) in config; on provider-down (retryable exhausted) the daemon retries once on the fallback and emits a `fallback` event.
