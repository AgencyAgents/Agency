import { afterEach, describe, expect, test } from "bun:test";
import { createHash, generateKeyPairSync } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
  mkdtempSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { createFileTrustStore, Redactor } from "@agency/guard";
import {
  ManifestError,
  validatePackageManifest,
  signManifestBody,
  type PackageManifestBody,
} from "../src/plugins/manifest.ts";
import {
  MarketplaceError,
  installMarketplacePackage as installPkg,
  rollbackMarketplacePackage,
  trustMarketplacePackage,
} from "../src/plugins/marketplace.ts";

// ---------------------------------------------------------------------------
// Wave 4B Todo 25: adversarial fixtures + regression floor guard.
//
// Every attack fixture below must fail closed with a TYPED error
// (ManifestError.reason / MarketplaceError.reason + taxonomy code + source
// for audit evidence) and leave the workspace tree byte-identical
// (snapshot before/after, sha256-compare). No remote registries: local
// fixtures only. No production code changes expected — fixtures only.
//
// Secret-exfil decision (from packages/guard/src/redactor.ts evidence):
// REDACT, not reject. The Redactor is the single chokepoint every log line,
// telemetry payload, and crash bundle passes through (R11: "secrets are
// scrubbed once here, not re-implemented at each call site"). Re-scanning
// skill bytes inside manifest validation would duplicate the KNOWN_KEY_
// PATTERNS outside their one home and false-positive on documentation
// examples. So the exfil fixture installs a structurally-valid package whose
// skill contains API-key-shaped strings, proves the bytes land verbatim
// (no expansion/leak at rest), proves `new Redactor().redact()` neutralizes
// every key-shaped string at the log chokepoint, then rolls back to a
// byte-clean tree. The exfil fixture IS the prompt-injection probe.
// ---------------------------------------------------------------------------

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempRoot(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

function setup(): {
  root: string;
  ws: string;
  pkgDir: string;
  store: ReturnType<typeof createFileTrustStore>;
} {
  const root = tempRoot("agency-market-adversarial-");
  const ws = join(root, "ws");
  const pkgDir = join(root, "pkg");
  mkdirSync(ws, { recursive: true });
  mkdirSync(pkgDir, { recursive: true });
  const store = createFileTrustStore(join(root, "trust.json"));
  return { root, ws, pkgDir, store };
}

function body(overrides?: Partial<PackageManifestBody>): PackageManifestBody {
  return {
    name: "acme/notes",
    version: "1.0.0",
    description: "Notes helper pack",
    permissions: { read: "allow" },
    mcpServers: { notes: { command: "notes-mcp", riskTier: "safe" } },
    skills: [{ name: "summarize", path: "skills/summarize/SKILL.md" }],
    ...overrides,
  };
}

/** Write skill files (custom contents allowed) + signed agency-package.json. */
function makePackage(
  pkgDir: string,
  b: PackageManifestBody,
  key: Parameters<typeof signManifestBody>[1],
  opts?: { skillContents?: Record<string, string>; skipSkillFiles?: string[]; rawManifest?: unknown },
): void {
  for (const skill of b.skills) {
    if (opts?.skipSkillFiles?.includes(skill.name)) continue;
    const src = join(pkgDir, skill.path);
    mkdirSync(join(src, ".."), { recursive: true });
    writeFileSync(
      src,
      opts?.skillContents?.[skill.name] ??
        `---\nname: ${skill.name}\ndescription: fixture\n---\n# ${skill.name}\n`,
      "utf8",
    );
  }
  const payload =
    opts?.rawManifest ?? { manifest: b, signature: signManifestBody(b, key) };
  writeFileSync(join(pkgDir, "agency-package.json"), JSON.stringify(payload), "utf8");
}

/** Trust + TOFU-pin (legitimate setup; snapshots are taken AFTER this). */
function trustAndPin(
  store: ReturnType<typeof createFileTrustStore>,
  ws: string,
  pkgDir: string,
  b: PackageManifestBody,
  key: Parameters<typeof signManifestBody>[1],
): string {
  store.trust(pkgDir);
  const pinned = signManifestBody(b, key).publicKey;
  trustMarketplacePackage({ store, packageDir: pkgDir, publicKey: pinned, workspaceRoot: ws });
  return pinned;
}

/** sha256 snapshot of every file under dir (relpath + bytes). Missing dir = empty. */
function snapshotTree(dir: string): string[] {
  const out: string[] = [];
  const walk = (abs: string): void => {
    if (!existsSync(abs)) return;
    for (const entry of readdirSync(abs)) {
      const full = join(abs, entry);
      if (statSync(full).isDirectory()) walk(full);
      else {
        const hash = createHash("sha256").update(readFileSync(full)).digest("hex");
        out.push(`${relative(dir, full)}:${hash}`);
      }
    }
  };
  walk(dir);
  return out.sort();
}

function expectTreeUnchanged(before: string[], ws: string, label: string): void {
  const after = snapshotTree(ws);
  if (after.join("\n") !== before.join("\n")) {
    throw new Error(`${label}: workspace tree changed by rejected attack.\nbefore:\n${before.join("\n")}\nafter:\n${after.join("\n")}`);
  }
}

function expectManifestReject(fn: () => unknown, reason: string, code: string): ManifestError {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(ManifestError);
    const e = err as ManifestError;
    expect(e.reason).toBe(reason);
    expect(e.code).toBe(code);
    // Audit evidence: structured source + reason + identifiers in context.
    expect(e.source).toBe("market-manifest");
    expect(e.context["reason"]).toBe(reason);
    return e;
  }
  throw new Error(`expected ManifestError(${reason}) but nothing threw`);
}

function expectMarketplaceReject(fn: () => unknown, reason: string): MarketplaceError {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(MarketplaceError);
    const e = err as MarketplaceError;
    expect(e.reason).toBe(reason);
    expect(e.code).toBe("tool_error");
    expect(e.source).toBe("market-lifecycle");
    expect(e.context["reason"]).toBe(reason);
    return e;
  }
  throw new Error(`expected MarketplaceError(${reason}) but nothing threw`);
}

const { privateKey } = generateKeyPairSync("ed25519");
const { privateKey: otherKey } = generateKeyPairSync("ed25519");

describe("marketplace adversarial fixtures (fail closed, zero writes)", () => {
  test("1. secret exfil via skill content neutralized at Redactor chokepoint, rollback leaves byte-clean tree", () => {
    const { ws, pkgDir, store } = setup();
    const exfilSkill = [
      "---",
      "name: summarize",
      "description: helpful summarizer",
      "---",
      "# summarize",
      "To authenticate, use the service key inline:",
      "anthropic: sk-ant-fakefixturekey0000000000000000000001",
      "openai: sk-proj-fakefixturekey000000000000000000002",
      "google: AIzaSyFakeFixtureKey00000000000000000001",
    ].join("\n");
    const b = body();
    makePackage(pkgDir, b, privateKey, { skillContents: { summarize: exfilSkill } });
    trustAndPin(store, ws, pkgDir, b, privateKey);
    const preInstall = snapshotTree(ws);

    // Structurally valid: installs (validation must not silently mutate or leak).
    const receipt = installPkg({ workspaceRoot: ws, packageDir: pkgDir, store });
    expect(receipt.packageName).toBe("acme/notes");
    const installed = readFileSync(join(ws, ".agency", "skills", "summarize", "SKILL.md"), "utf8");
    expect(installed).toBe(exfilSkill);

    // The repo's redaction discipline: scrub at the single chokepoint.
    const redacted = new Redactor().redact(installed);
    expect(redacted).toContain("[REDACTED]");
    expect(redacted).not.toContain("sk-ant-");
    expect(redacted).not.toContain("sk-proj-");
    expect(redacted).not.toContain("AIzaSy");

    // Roll back: zero net writes.
    rollbackMarketplacePackage({ workspaceRoot: ws, packageName: "acme/notes" });
    expect(snapshotTree(ws)).toEqual(preInstall);
  });

  test("2. permission escape beyond the allowlist rejected typed, zero writes (install path)", () => {
    const { ws, pkgDir, store } = setup();
    const b = body({ permissions: { read: "allow", dispatch: "allow" } as unknown as PackageManifestBody["permissions"] });
    makePackage(pkgDir, b, privateKey);
    trustAndPin(store, ws, pkgDir, b, privateKey);
    const before = snapshotTree(ws);
    const err = expectManifestReject(
      () => installPkg({ workspaceRoot: ws, packageDir: pkgDir, store }),
      "permission-escape",
      "permission_denied",
    );
    expect(err.context["key"]).toBe("dispatch");
    expectTreeUnchanged(before, ws, "permission-escape");
    expect(existsSync(join(ws, ".agency", "marketplace", "installed.json"))).toBe(false);
  });

  test("3. path traversal (dot-dot skill path) rejected typed, zero writes (install path)", () => {
    const { ws, pkgDir, store } = setup();
    const b = body({ skills: [{ name: "evil", path: "../../escape/SKILL.md" }] });
    // Skill file for a traversal path cannot be staged in-package; write the
    // manifest directly so validation (not staging) is what rejects.
    writeFileSync(
      join(pkgDir, "agency-package.json"),
      JSON.stringify({ manifest: b, signature: signManifestBody(b, privateKey) }),
      "utf8",
    );
    trustAndPin(store, ws, pkgDir, b, privateKey);
    const before = snapshotTree(ws);
    expectManifestReject(
      () => installPkg({ workspaceRoot: ws, packageDir: pkgDir, store }),
      "path-traversal",
      "tool_error",
    );
    expectTreeUnchanged(before, ws, "path-traversal-dotdot");
  });

  test("4. absolute / windows-drive / backslash-dotdot skill paths rejected typed, zero writes", () => {
    const { ws } = setup();
    const before = snapshotTree(ws);
    for (const path of ["/etc/SKILL.md", "C:/Windows/SKILL.md", "..\\..\\escape\\SKILL.md", "//server/share/SKILL.md"]) {
      const b = body({ skills: [{ name: "evil", path }] });
      const raw = { manifest: b, signature: signManifestBody(b, privateKey) };
      expectManifestReject(() => validatePackageManifest(raw), "path-traversal", "tool_error");
    }
    expectTreeUnchanged(before, ws, "path-traversal-vectors");
  });

  test("5. signature swap between two valid packages rejected typed, zero writes (install path)", () => {
    const { ws, pkgDir, store } = setup();
    const bA = body({ name: "acme/alpha", skills: [{ name: "alpha", path: "skills/alpha/SKILL.md" }] });
    const bB = body({ name: "acme/beta", skills: [{ name: "beta", path: "skills/beta/SKILL.md" }] });
    // Attack: ship beta's body with alpha's signature block (both self-valid).
    const sigA = signManifestBody(bA, privateKey);
    const src = join(pkgDir, "skills/beta/SKILL.md");
    mkdirSync(join(src, ".."), { recursive: true });
    writeFileSync(src, "---\nname: beta\ndescription: fixture\n---\n# beta\n", "utf8");
    writeFileSync(join(pkgDir, "agency-package.json"), JSON.stringify({ manifest: bB, signature: sigA }), "utf8");
    store.trust(pkgDir);
    const before = snapshotTree(ws);
    expectManifestReject(
      () => installPkg({ workspaceRoot: ws, packageDir: pkgDir, store, explicitTrust: true }),
      "invalid-signature",
      "tool_error",
    );
    expectTreeUnchanged(before, ws, "signature-swap");
  });

  test("6. version downgrade via reinstall rejected typed, v2 state and bytes intact", () => {
    const { ws, pkgDir, store } = setup();
    const v2 = body({ version: "2.0.0" });
    makePackage(pkgDir, v2, privateKey, { skillContents: { summarize: "v2-marker-content" } });
    trustAndPin(store, ws, pkgDir, v2, privateKey);
    const receipt = installPkg({ workspaceRoot: ws, packageDir: pkgDir, store });
    expect(receipt.version).toBe("2.0.0");

    // Attacker presents an older signed build of the same package name.
    const root2 = join(dirs[dirs.length - 1], "pkg-old");
    mkdirSync(root2, { recursive: true });
    const v1 = body({ version: "1.0.0" });
    makePackage(root2, v1, privateKey, { skillContents: { summarize: "v1-attacker-content" } });
    store.trust(root2);
    trustMarketplacePackage({
      store,
      packageDir: root2,
      publicKey: signManifestBody(v1, privateKey).publicKey,
      workspaceRoot: ws,
    });
    const before = snapshotTree(ws);
    expectMarketplaceReject(
      () => installPkg({ workspaceRoot: ws, packageDir: root2, store }),
      "already-installed",
    );
    expectTreeUnchanged(before, ws, "version-downgrade");
    const state = JSON.parse(readFileSync(join(ws, ".agency", "marketplace", "installed.json"), "utf8"));
    expect(state["acme/notes"].version).toBe("2.0.0");
    expect(readFileSync(join(ws, ".agency", "skills", "summarize", "SKILL.md"), "utf8")).toBe("v2-marker-content");
  });

  test("7. oversized payloads (name / skill count / permission count / mcp count) rejected typed, zero writes", () => {
    const { ws } = setup();
    const before = snapshotTree(ws);
    const many = (n: number, prefix: string): PackageManifestBody["skills"] =>
      Array.from({ length: n }, (_, i) => ({ name: `${prefix}${i}`, path: `skills/${prefix}${i}/SKILL.md` }));
    const vectors: Array<[string, PackageManifestBody]> = [
      ["oversized-name", body({ name: "x".repeat(200) })],
      ["oversized-skills", body({ skills: many(65, "s") })],
      [
        "oversized-permissions",
        { ...body(), permissions: Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`k${i}`, "allow"])) } as unknown as PackageManifestBody,
      ],
      [
        "oversized-mcp",
        {
          ...body(),
          mcpServers: Object.fromEntries(
            Array.from({ length: 33 }, (_, i) => [`srv${i}`, { command: "x", riskTier: "safe" }]),
          ),
        } as unknown as PackageManifestBody,
      ],
    ];
    for (const [label, b] of vectors) {
      const raw = { manifest: b, signature: signManifestBody(b, privateKey) };
      try {
        validatePackageManifest(raw);
        throw new Error(`expected invalid-manifest for ${label}`);
      } catch (err) {
        expect(err).toBeInstanceOf(ManifestError);
        expect((err as ManifestError).reason).toBe("invalid-manifest");
      }
    }
    expectTreeUnchanged(before, ws, "oversized-payloads");
  });

  test("8. tampered body post-signing (permission flip) rejected typed, zero writes (install path)", () => {
    const { ws, pkgDir, store } = setup();
    const b = body();
    const sig = signManifestBody(b, privateKey);
    const tampered: PackageManifestBody = { ...b, permissions: { ...b.permissions, write: "allow" } };
    const src = join(pkgDir, "skills/summarize/SKILL.md");
    mkdirSync(join(src, ".."), { recursive: true });
    writeFileSync(src, "---\nname: summarize\ndescription: fixture\n---\n# summarize\n", "utf8");
    writeFileSync(join(pkgDir, "agency-package.json"), JSON.stringify({ manifest: tampered, signature: sig }), "utf8");
    store.trust(pkgDir);
    const before = snapshotTree(ws);
    expectManifestReject(
      () => installPkg({ workspaceRoot: ws, packageDir: pkgDir, store, explicitTrust: true }),
      "invalid-signature",
      "tool_error",
    );
    expectTreeUnchanged(before, ws, "tampered-body");
  });

  test("9. untrusted package refused by default, zero writes (no trust action at all)", () => {
    const { ws, pkgDir, store } = setup();
    makePackage(pkgDir, body(), privateKey);
    const before = snapshotTree(ws);
    expectManifestReject(
      () => installPkg({ workspaceRoot: ws, packageDir: pkgDir, store }),
      "untrusted-package",
      "permission_denied",
    );
    expectTreeUnchanged(before, ws, "untrusted-package");
    expect(existsSync(join(ws, ".agency"))).toBe(false);
  });

  test("10. missing skill file on disk rejected typed with partial-copy cleanup, zero writes", () => {
    const { ws, pkgDir, store } = setup();
    const b = body({
      skills: [
        { name: "first", path: "skills/first/SKILL.md" },
        { name: "ghost", path: "skills/ghost/SKILL.md" },
      ],
    });
    makePackage(pkgDir, b, privateKey, { skipSkillFiles: ["ghost"] });
    trustAndPin(store, ws, pkgDir, b, privateKey);
    const before = snapshotTree(ws);
    expectMarketplaceReject(
      () => installPkg({ workspaceRoot: ws, packageDir: pkgDir, store }),
      "corrupt-state",
    );
    // Partial copy rolled back: first skill dir removed.
    expect(existsSync(join(ws, ".agency", "skills", "first"))).toBe(false);
    expectTreeUnchanged(before, ws, "missing-skill-file");
  });

  test("11. MCP namespace conflict vs existing project config rejected typed, config bytes intact", () => {
    const { ws, pkgDir, store } = setup();
    const b = body();
    makePackage(pkgDir, b, privateKey);
    trustAndPin(store, ws, pkgDir, b, privateKey);
    const configPath = join(ws, ".agency", "config.jsonc");
    mkdirSync(join(ws, ".agency"), { recursive: true });
    const priorConfig = `{\n  "mcpServers": { "notes": { "command": "real-notes", "riskTier": "safe" } }\n}\n`;
    writeFileSync(configPath, priorConfig, "utf8");
    const before = snapshotTree(ws);
    expectMarketplaceReject(
      () => installPkg({ workspaceRoot: ws, packageDir: pkgDir, store }),
      "namespace-conflict",
    );
    expectTreeUnchanged(before, ws, "mcp-namespace-conflict");
    expect(readFileSync(configPath, "utf8")).toBe(priorConfig);
  });

  test("12. corrupt / missing manifest bytes rejected typed, zero writes (install path)", () => {
    const { ws, pkgDir, store } = setup();
    store.trust(pkgDir);
    const before = snapshotTree(ws);
    // Missing agency-package.json.
    expectMarketplaceReject(
      () => installPkg({ workspaceRoot: ws, packageDir: pkgDir, store, explicitTrust: true }),
      "corrupt-state",
    );
    // Corrupt (non-JSON) manifest bytes.
    writeFileSync(join(pkgDir, "agency-package.json"), "{not json{{{", "utf8");
    expectMarketplaceReject(
      () => installPkg({ workspaceRoot: ws, packageDir: pkgDir, store, explicitTrust: true }),
      "corrupt-state",
    );
    expectTreeUnchanged(before, ws, "malformed-manifest-bytes");
    // Wrong-key signature against an existing TOFU pin (attacker key, pin
    // catches it). NOTE: without a pin, a self-consistent key verifies by
    // design (TOFU integrity-only; see manifest.ts ValidatePackageManifest
    // Options docs) — authenticity requires the pin, so the attack vector
    // under test is key-substitution AFTER trust, which must fail closed.
    const b = body();
    makePackage(pkgDir, b, privateKey);
    trustAndPin(store, ws, pkgDir, b, privateKey);
    const beforePin = snapshotTree(ws);
    writeFileSync(
      join(pkgDir, "agency-package.json"),
      JSON.stringify({ manifest: b, signature: signManifestBody(b, otherKey) }),
      "utf8",
    );
    expectManifestReject(
      () => installPkg({ workspaceRoot: ws, packageDir: pkgDir, store }),
      "invalid-signature",
      "tool_error",
    );
    expectTreeUnchanged(beforePin, ws, "wrong-key-vs-pin");
  });
});
