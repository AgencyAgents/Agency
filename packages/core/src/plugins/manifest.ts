import { Buffer } from "node:buffer";
import { createPrivateKey, createPublicKey, sign, verify, type KeyObject } from "node:crypto";
import { z } from "zod";
import type { ToolPermissionValue, TrustStore } from "@agency/guard";
import { AgencyError, ErrorCode } from "@agency/schema";
import { McpServerConfigSchema } from "@agency/tools";

// ---------------------------------------------------------------------------
// Marketplace package manifest (Wave 4B, Todo 23).
//
// Schema + validation ONLY. No install/enable/disable/rollback (Todo 24),
// no adversarial suite (Todo 25). References TrustStore/PermissionsGate
// concepts and McpServerConfigSchema without reshaping any of them.
// ---------------------------------------------------------------------------

/** Typed reasons every manifest rejection carries. */
export type ManifestIssue =
  | "invalid-manifest"
  | "invalid-signature"
  | "permission-escape"
  | "path-traversal"
  | "untrusted-package";

/** Typed error for all manifest rejections. Code follows the taxonomy: policy
 *  failures (escape, untrusted) are PERMISSION_DENIED, structural/crypto
 *  failures are TOOL_ERROR. The `reason` field discriminates. */
export class ManifestError extends AgencyError {
  readonly reason: ManifestIssue;
  constructor(reason: ManifestIssue, message: string, context?: Record<string, unknown>) {
    super(
      reason === "permission-escape" || reason === "untrusted-package"
        ? ErrorCode.PERMISSION_DENIED
        : ErrorCode.TOOL_ERROR,
      message,
      { source: "market-manifest", context: { reason, ...context } },
    );
    this.name = "ManifestError";
    this.reason = reason;
  }
}

// --- Field caps (basic malformed/oversized defense; deep fuzzing is Todo 25) ---
export const MANIFEST_MAX_NAME_LEN = 128;
export const MANIFEST_MAX_VERSION_LEN = 32;
export const MANIFEST_MAX_SKILLS = 64;
export const MANIFEST_MAX_MCP_SERVERS = 32;
export const MANIFEST_MAX_PERMISSIONS = 64;
export const MANIFEST_MAX_SKILL_PATH_LEN = 256;

const PACKAGE_NAME_RE = /^[a-z0-9][a-z0-9._-]*(\/[a-z0-9][a-z0-9._-]*)?$/;
const SEMVER_RE = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/;
const SKILL_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const DECISION_RE = /^(allow|ask|deny)$/;

/**
 * Permission keys a marketplace package may request. Anything outside this
 * allowlist is a permission escape and fails closed. Deliberately narrow:
 * orchestration and unlisted tools stay out of marketplace reach. Callers may
 * pass a custom allowlist via validate options; the default is the contract.
 */
export const DEFAULT_MARKETPLACE_PERMISSION_KEYS: readonly string[] = [
  "read",
  "write",
  "edit",
  "bash",
  "git_write",
  "external_directory",
];

const PermissionValueSchema = z.union([
  z.enum(["allow", "ask", "deny"]),
  z.record(z.string(), z.enum(["allow", "ask", "deny"])),
]);

export const PackageSkillSchema = z.object({
  name: z.string().min(1).max(MANIFEST_MAX_NAME_LEN),
  path: z.string().min(1).max(MANIFEST_MAX_SKILL_PATH_LEN),
  description: z.string().max(2000).optional(),
});

export const PackageSignatureSchema = z.object({
  /** ed25519 public key, SPKI DER base64 (same encoding as release signing). */
  publicKey: z.string().min(1).max(256),
  /** Raw 64-byte ed25519 signature over the canonical body, base64. */
  signature: z.string().min(1).max(256),
});

export const PackageManifestBodySchema = z.object({
  name: z.string().min(1).max(MANIFEST_MAX_NAME_LEN),
  version: z.string().min(1).max(MANIFEST_MAX_VERSION_LEN),
  description: z.string().max(4000).optional(),
  permissions: z.record(z.string(), PermissionValueSchema).optional().default({}),
  mcpServers: z.record(z.string(), McpServerConfigSchema).optional().default({}),
  skills: z.array(PackageSkillSchema).max(MANIFEST_MAX_SKILLS).optional().default([]),
});

export const PackageManifestSchema = z.object({
  manifest: PackageManifestBodySchema,
  signature: PackageSignatureSchema,
});

export type PackageManifestBody = z.infer<typeof PackageManifestBodySchema>;
export type PackageManifest = z.infer<typeof PackageManifestSchema>;
export type PackageSkill = z.infer<typeof PackageSkillSchema>;

// ---------------------------------------------------------------------------
// Canonical bytes + ed25519 (mirrors scripts/sign-release.ts + cli/update.ts)
// ---------------------------------------------------------------------------

/** Decision: hash-pinned ed25519, mirroring release signing. HMAC needs a
 *  shared secret (no distribution story for a marketplace); local-trust alone
 *  gives no tamper evidence. node:crypto sign/verify with SPKI-DER-b64 keys,
 *  exactly the sign-release.ts encoding. */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`);
  return `{${entries.join(",")}}`;
}

/** Canonical bytes the signature covers: stable-key-sorted JSON of the body
 *  (name, version, permissions, mcpServers, skills) — never the signature. */
export function canonicalManifestBody(body: PackageManifestBody): Buffer {
  return Buffer.from(stableStringify(body), "utf8");
}

/** Sign a manifest body (fixture/tooling helper; Todo 24+ producers use this
 *  shape). Accepts a KeyObject so tests use ephemeral keypairs. */
export function signManifestBody(
  body: PackageManifestBody,
  privateKey: KeyObject,
): { publicKey: string; signature: string } {
  const payload = canonicalManifestBody(body);
  const signature = sign(undefined, payload, privateKey);
  const publicKey = (createPublicKey(privateKey).export({ format: "der", type: "spki" }) as Buffer).toString(
    "base64",
  );
  return { publicKey, signature: signature.toString("base64") };
}

/** Accepts a PKCS8-DER-b64 ed25519 private key (sign-release.ts encoding) for
 *  callers that hold keys as strings rather than KeyObjects. */
export function signManifestBodyWithB64Key(
  body: PackageManifestBody,
  privateKeyB64: string,
): { publicKey: string; signature: string } {
  return signManifestBody(body, createPrivateKey({ key: Buffer.from(privateKeyB64, "base64"), format: "der", type: "pkcs8" }));
}

/** Verify the detached signature. Any failure (bad key, bad length, crypto
 *  mismatch) is a typed invalid-signature rejection — fail closed. */
export function verifyManifestSignature(body: PackageManifestBody, signature: PackageManifest["signature"]): void {
  let keyObject: KeyObject;
  try {
    keyObject = createPublicKey({ key: Buffer.from(signature.publicKey, "base64"), format: "der", type: "spki" });
  } catch {
    throw new ManifestError("invalid-signature", "manifest public key is not a valid ed25519 SPKI key");
  }
  let sigBytes: Buffer;
  try {
    sigBytes = Buffer.from(signature.signature, "base64");
  } catch {
    throw new ManifestError("invalid-signature", "manifest signature is not valid base64");
  }
  if (sigBytes.length !== 64) {
    throw new ManifestError("invalid-signature", `manifest signature must be 64 bytes, got ${sigBytes.length}`);
  }
  let ok = false;
  try {
    ok = verify(undefined, canonicalManifestBody(body), keyObject, sigBytes);
  } catch {
    ok = false;
  }
  if (!ok) throw new ManifestError("invalid-signature", "manifest signature verification failed (tampered or wrong key)");
}

// ---------------------------------------------------------------------------
// Structural checks: traversal + permission escape
// ---------------------------------------------------------------------------

/** Lexical traversal guard (mirrors the trust.ts normalizeDir discipline:
 *  no realpath available for not-yet-installed files, so reject lexically). */
export function assertTraversalFree(label: string, value: string): void {
  const normalized = value.replace(/\\/g, "/");
  const isAbsolute = normalized.startsWith("/") || /^[A-Za-z]:(\/|$)/.test(normalized) || normalized.startsWith("//");
  const segments = normalized.split("/");
  if (isAbsolute || segments.includes("..")) {
    throw new ManifestError("path-traversal", `${label} must be a relative in-package path without "..": ${value}`);
  }
  if (value.length === 0) throw new ManifestError("path-traversal", `${label} must not be empty`);
}

function checkManifestShape(body: PackageManifestBody): void {
  if (!PACKAGE_NAME_RE.test(body.name)) {
    throw new ManifestError("invalid-manifest", `manifest name "${body.name}" must match ${PACKAGE_NAME_RE.source}`);
  }
  if (!SEMVER_RE.test(body.version)) {
    throw new ManifestError("invalid-manifest", `manifest version "${body.version}" must be semver x.y.z`);
  }
  const seenSkills = new Set<string>();
  for (const skill of body.skills) {
    if (!SKILL_NAME_RE.test(skill.name)) {
      throw new ManifestError("invalid-manifest", `skill name "${skill.name}" must match ${SKILL_NAME_RE.source}`);
    }
    if (seenSkills.has(skill.name)) {
      throw new ManifestError("invalid-manifest", `duplicate skill name "${skill.name}"`);
    }
    seenSkills.add(skill.name);
    assertTraversalFree(`skill "${skill.name}" path`, skill.path);
  }
  const serverNames = Object.keys(body.mcpServers);
  if (serverNames.length > MANIFEST_MAX_MCP_SERVERS) {
    throw new ManifestError("invalid-manifest", `too many mcpServers (${serverNames.length} > ${MANIFEST_MAX_MCP_SERVERS})`);
  }
  const permKeys = Object.keys(body.permissions);
  if (permKeys.length > MANIFEST_MAX_PERMISSIONS) {
    throw new ManifestError("invalid-manifest", `too many permissions (${permKeys.length} > ${MANIFEST_MAX_PERMISSIONS})`);
  }
  for (const [tool, value] of Object.entries(body.permissions)) {
    void (value as ToolPermissionValue);
    if (typeof value === "string" && !DECISION_RE.test(value)) {
      throw new ManifestError("invalid-manifest", `permission "${tool}" has invalid decision "${value}"`);
    }
  }
}

/** Reject permission keys outside the allowlist. Reads the same
 *  ToolPermissionValue grammar the PermissionsGate evaluates — reference,
 *  not reshape. */
export function assertPermissionsAllowlisted(
  permissions: Record<string, unknown>,
  allowed: readonly string[] = DEFAULT_MARKETPLACE_PERMISSION_KEYS,
): void {
  const allow = new Set(allowed);
  for (const key of Object.keys(permissions)) {
    if (!allow.has(key)) {
      throw new ManifestError("permission-escape", `permission "${key}" is outside the marketplace allowlist`, {
        key,
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Trust / default-off (reuses TrustStore; mirrors requireTrust semantics)
// ---------------------------------------------------------------------------

export interface PackageTrustStatus {
  /** True only after an explicit trust action (store trust or explicitTrust). */
  trusted: boolean;
  /** Installs always land disabled; enabling is a separate action (Todo 24). */
  enabled: false;
}

/** Default-off gate: untrusted packages are reported, never installed, until
 *  an explicit trust action. Never throws — returns the status. */
export function packageInstallAllowed(options: {
  store: TrustStore;
  packageDir: string;
  explicitTrust?: boolean;
}): PackageTrustStatus {
  const trusted = options.explicitTrust === true || options.store.isTrusted(options.packageDir);
  return { trusted, enabled: false as const };
}

/** Throwing variant (requireTrust semantics): PERMISSION_DENIED with reason
 *  untrusted-package when the default-off gate refuses. */
export function requirePackageTrust(options: {
  store: TrustStore;
  packageDir: string;
  explicitTrust?: boolean;
}): void {
  const status = packageInstallAllowed(options);
  if (!status.trusted) {
    throw new ManifestError("untrusted-package", `package at "${options.packageDir}" is not trusted; explicit trust required`, {
      packageDir: options.packageDir,
    });
  }
}

// ---------------------------------------------------------------------------
// Main entry point (downstream contract for Todos 24-25)
// ---------------------------------------------------------------------------

export interface ValidatePackageManifestOptions {
  /** Override the permission allowlist (default DEFAULT_MARKETPLACE_PERMISSION_KEYS). */
  allowedPermissions?: readonly string[];
  /**
   * Pinned publisher public key (SPKI DER b64). The embedded signature key is
   * self-asserted (TOFU): without a pin, any self-consistent key verifies
   * (integrity only). Pass the publisher key pinned at trust time for
   * authenticity; mismatch throws invalid-signature.
   */
  expectedPublicKey?: string;
}

export interface ValidatedPackageManifest {
  manifest: PackageManifestBody;
  /** Trust is reported, not decided, here — Todo 24 wires install/enable. */
  trust: PackageTrustStatus;
}

/**
 * Validate a package manifest: schema → shape/traversal → permission
 * allowlist → ed25519 signature. Trust stays default-off and is reported via
 * `trust` (use requirePackageTrust to enforce). Throws ManifestError.
 */
export function validatePackageManifest(
  raw: unknown,
  options?: ValidatePackageManifestOptions,
  trustOptions?: { store: TrustStore; packageDir: string; explicitTrust?: boolean },
): ValidatedPackageManifest {
  const parsed = PackageManifestSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ManifestError("invalid-manifest", `manifest schema validation failed: ${parsed.error.message}`);
  }
  const { manifest: body, signature } = parsed.data;
  checkManifestShape(body);
  assertPermissionsAllowlisted(body.permissions, options?.allowedPermissions);
  if (options?.expectedPublicKey !== undefined && signature.publicKey !== options.expectedPublicKey) {
    throw new ManifestError("invalid-signature", "manifest public key does not match the pinned publisher key");
  }
  verifyManifestSignature(body, signature);
  const trust: PackageTrustStatus = trustOptions ? packageInstallAllowed(trustOptions) : { trusted: false, enabled: false };
  return { manifest: body, trust };
}
