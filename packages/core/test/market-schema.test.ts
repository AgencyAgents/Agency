import { describe, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFileTrustStore } from "@agency/guard";
import {
  ManifestError,
  type PackageManifestBody,
  packageInstallAllowed,
  requirePackageTrust,
  signManifestBody,
  validatePackageManifest,
} from "../src/plugins/manifest.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const { privateKey } = generateKeyPairSync("ed25519");
const { privateKey: otherKey } = generateKeyPairSync("ed25519");

function body(overrides?: Partial<PackageManifestBody>): PackageManifestBody {
  return {
    name: "acme/notes",
    version: "1.2.3",
    description: "Notes helper pack",
    permissions: { read: "allow", bash: { "git status": "ask" } },
    mcpServers: { notes: { command: "notes-mcp", riskTier: "safe" } },
    skills: [{ name: "summarize", path: "skills/summarize/SKILL.md" }],
    ...overrides,
  };
}

function signedRaw(b: PackageManifestBody, key = privateKey): unknown {
  return { manifest: b, signature: signManifestBody(b, key) };
}

function expectManifestError(fn: () => unknown, reason: string, code?: string): ManifestError {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(ManifestError);
    const e = err as ManifestError;
    expect(e.reason).toBe(reason);
    if (code) expect(e.code).toBe(code);
    return e;
  }
  throw new Error(`expected ManifestError(${reason}) but nothing threw`);
}

function makeTrustStore(): { store: ReturnType<typeof createFileTrustStore>; dir: string; pkgDir: string } {
  const dir = mkdtempSync(join(tmpdir(), "agency-market-"));
  const store = createFileTrustStore(join(dir, "trust.json"));
  const pkgDir = join(dir, "pkg", "acme-notes");
  return { store, dir, pkgDir };
}

// ---------------------------------------------------------------------------
// Valid / tampered / escape / traversal / default-off matrix
// ---------------------------------------------------------------------------

describe("marketplace manifest schema", () => {
  test("valid signed manifest validates", () => {
    const out = validatePackageManifest(signedRaw(body()));
    expect(out.manifest.name).toBe("acme/notes");
    expect(out.manifest.version).toBe("1.2.3");
    expect(out.trust.trusted).toBe(false);
    expect(out.trust.enabled).toBe(false);
  });

  test("tampered body rejected (invalid-signature)", () => {
    const b = body();
    const raw = signedRaw(b) as {
      manifest: PackageManifestBody;
      signature: { publicKey: string; signature: string };
    };
    const tampered = {
      manifest: { ...b, permissions: { ...b.permissions, write: "allow" } },
      signature: raw.signature,
    };
    expectManifestError(() => validatePackageManifest(tampered), "invalid-signature", "tool_error");
  });

  test("wrong-key signature rejected against pinned publisher key (invalid-signature)", () => {
    const pinned = signManifestBody(body(), privateKey).publicKey;
    expectManifestError(
      () => validatePackageManifest(signedRaw(body(), otherKey), { expectedPublicKey: pinned }),
      "invalid-signature",
      "tool_error",
    );
    // Pinned + correct key passes (authenticity via pinning).
    const out = validatePackageManifest(signedRaw(body()), { expectedPublicKey: pinned });
    expect(out.manifest.name).toBe("acme/notes");
  });

  test("corrupt signature bytes rejected (invalid-signature)", () => {
    const raw = signedRaw(body()) as {
      manifest: PackageManifestBody;
      signature: { publicKey: string; signature: string };
    };
    raw.signature.signature = Buffer.from("x".repeat(64)).toString("base64");
    expectManifestError(() => validatePackageManifest(raw), "invalid-signature", "tool_error");
  });

  test("permission escape rejected (permission-escape)", () => {
    const b = body({ permissions: { dispatch: "allow" } as unknown as PackageManifestBody["permissions"] });
    // Bypass the zod decision check by signing a body cast through unknown
    const raw = { manifest: b, signature: signManifestBody(b, privateKey) };
    expectManifestError(() => validatePackageManifest(raw), "permission-escape", "permission_denied");
  });

  test("traversal skill path rejected (path-traversal)", () => {
    const b = body({ skills: [{ name: "evil", path: "../../etc/SKILL.md" }] });
    expectManifestError(() => validatePackageManifest(signedRaw(b)), "path-traversal", "tool_error");
  });

  test("absolute skill path rejected (path-traversal)", () => {
    const b = body({ skills: [{ name: "evil", path: "/etc/SKILL.md" }] });
    expectManifestError(() => validatePackageManifest(signedRaw(b)), "path-traversal", "tool_error");
  });

  test("windows-absolute skill path rejected (path-traversal)", () => {
    const b = body({ skills: [{ name: "evil", path: "C:/Windows/SKILL.md" }] });
    expectManifestError(() => validatePackageManifest(signedRaw(b)), "path-traversal", "tool_error");
  });

  test("untrusted default-off: install refused without explicit trust", () => {
    const { store, dir, pkgDir } = makeTrustStore();
    try {
      const status = packageInstallAllowed({ store, packageDir: pkgDir });
      expect(status.trusted).toBe(false);
      expect(status.enabled).toBe(false);
      expectManifestError(
        () => requirePackageTrust({ store, packageDir: pkgDir }),
        "untrusted-package",
        "permission_denied",
      );
      // validatePackageManifest with trust inputs reports untrusted, still validates shape+sig
      const out = validatePackageManifest(signedRaw(body()), undefined, { store, packageDir: pkgDir });
      expect(out.trust.trusted).toBe(false);
      expect(out.trust.enabled).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("explicit trust action allows install, still disabled by default", () => {
    const { store, dir, pkgDir } = makeTrustStore();
    try {
      store.trust(pkgDir);
      const status = packageInstallAllowed({ store, packageDir: pkgDir });
      expect(status.trusted).toBe(true);
      expect(status.enabled).toBe(false);
      requirePackageTrust({ store, packageDir: pkgDir });
      const out = validatePackageManifest(signedRaw(body()), undefined, {
        store,
        packageDir: pkgDir,
        explicitTrust: true,
      });
      expect(out.trust.trusted).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // ---------------------------------------------------------------------------
  // Malformed matrix (basic here; adversarial fixtures belong to Todo 25)
  // ---------------------------------------------------------------------------

  test("malformed: non-object / corrupt JSON shape rejected (invalid-manifest)", () => {
    expectManifestError(() => validatePackageManifest(null), "invalid-manifest", "tool_error");
    expectManifestError(() => validatePackageManifest('{"name":'), "invalid-manifest", "tool_error");
    expectManifestError(() => validatePackageManifest({}), "invalid-manifest", "tool_error");
  });

  test("malformed: version skew rejected (invalid-manifest)", () => {
    for (const version of ["2", "v1.2.3", "1.2", "latest", "1.2.3.4.5.6"]) {
      const b = body({ version });
      expectManifestError(() => validatePackageManifest(signedRaw(b)), "invalid-manifest", "tool_error");
    }
  });

  test("malformed: duplicate skill names rejected (invalid-manifest)", () => {
    const b = body({
      skills: [
        { name: "dup", path: "skills/a/SKILL.md" },
        { name: "dup", path: "skills/b/SKILL.md" },
      ],
    });
    expectManifestError(() => validatePackageManifest(signedRaw(b)), "invalid-manifest", "tool_error");
  });

  test("malformed: oversized fields rejected (invalid-manifest)", () => {
    const b = body({ name: "x".repeat(200) });
    expectManifestError(() => validatePackageManifest(signedRaw(b)), "invalid-manifest", "tool_error");
    const b2 = body({ skills: [{ name: "s", path: "p/".repeat(200) }] });
    expectManifestError(() => validatePackageManifest(signedRaw(b2)), "invalid-manifest", "tool_error");
  });

  test("malformed: invalid mcp server entry rejected (invalid-manifest)", () => {
    const b = { ...body(), mcpServers: { bad: { url: "not-a-url" } } } as unknown as PackageManifestBody;
    expectManifestError(() => validatePackageManifest(signedRaw(b)), "invalid-manifest", "tool_error");
  });
});
