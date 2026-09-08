import { afterEach, describe, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFileTrustStore } from "@agency/guard";
import { ToolRegistry } from "@agency/tools";
import {
  EventBus,
  ManifestError,
  MarketplaceError,
  disableMarketplacePackage,
  enableMarketplacePackage,
  installMarketplacePackage,
  loadPlugins,
  rollbackMarketplacePackage,
  signManifestBody,
  trustMarketplacePackage,
  type PackageManifestBody,
} from "@agency/core";

// ---------------------------------------------------------------------------
// Helpers (local packages + fixtures only, no remote registries)
// ---------------------------------------------------------------------------

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
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

function makePackage(pkgDir: string, b: PackageManifestBody, key: Parameters<typeof signManifestBody>[1]): void {
  for (const skill of b.skills) {
    const src = join(pkgDir, skill.path);
    mkdirSync(join(src, ".."), { recursive: true });
    writeFileSync(src, `---\nname: ${skill.name}\ndescription: fixture\n---\n# ${skill.name}\n`, "utf8");
  }
  writeFileSync(join(pkgDir, "agency-package.json"), JSON.stringify({ manifest: b, signature: signManifestBody(b, key) }), "utf8");
}

function setup(): {
  ws: string;
  userCfg: string;
  pkgDir: string;
  store: ReturnType<typeof createFileTrustStore>;
} {
  const root = tempDir("agency-market-install-");
  const ws = join(root, "ws");
  const userCfg = join(root, "usercfg");
  const pkgDir = join(root, "pkg");
  mkdirSync(ws, { recursive: true });
  mkdirSync(userCfg, { recursive: true });
  mkdirSync(pkgDir, { recursive: true });
  const store = createFileTrustStore(join(root, "trust.json"));
  return { ws, userCfg, pkgDir, store };
}

function expectMarketplaceError(fn: () => unknown, reason: string): MarketplaceError {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(MarketplaceError);
    expect((err as MarketplaceError).reason).toBe(reason);
    return err as MarketplaceError;
  }
  throw new Error(`expected MarketplaceError(${reason}) but nothing threw`);
}

const { privateKey } = generateKeyPairSync("ed25519");
const { privateKey: otherKey } = generateKeyPairSync("ed25519");

// ---------------------------------------------------------------------------
// install -> enable -> disable -> rollback round-trip with config diff proof
// ---------------------------------------------------------------------------

describe("marketplace install lifecycle", () => {
  test("round-trip restores exact prior state (config diff proof) via loader paths", async () => {
    const { ws, userCfg, pkgDir, store } = setup();
    const b = body();
    makePackage(pkgDir, b, privateKey);
    const pinned = signManifestBody(b, privateKey).publicKey;
    trustMarketplacePackage({ store, packageDir: pkgDir, publicKey: pinned, workspaceRoot: ws });

    const configPath = join(ws, ".agency", "config.jsonc");
    mkdirSync(join(ws, ".agency"), { recursive: true });
    writeFileSync(configPath, `{\n  "permissions": { "read": "allow" }\n}\n`, "utf8");
    const beforeBytes = readFileSync(configPath, "utf8");

    const receipt = installMarketplacePackage({ workspaceRoot: ws, packageDir: pkgDir, store });
    expect(receipt.packageName).toBe("acme/notes");
    expect(receipt.enabled).toBe(false);
    expect(existsSync(join(ws, ".agency", "skills", "summarize", "SKILL.md"))).toBe(true);
    expect(readFileSync(configPath, "utf8")).toBe(beforeBytes);

    const bus = new EventBus();
    const loaded = await loadPlugins({ workspaceRoot: ws, configDirOverride: userCfg, bus });
    expect(loaded.plugins.some((p) => p.id === "summarize")).toBe(true);

    enableMarketplacePackage({ workspaceRoot: ws, packageName: "acme/notes" });
    const enabledCfg = JSON.parse(readFileSync(configPath, "utf8"));
    expect(enabledCfg.mcpServers.notes.command).toBe("notes-mcp");
    expect(enabledCfg.permissions.read).toBe("allow");

    disableMarketplacePackage({ workspaceRoot: ws, packageName: "acme/notes" });
    const disabledCfg = JSON.parse(readFileSync(configPath, "utf8"));
    expect(disabledCfg.mcpServers).toBeUndefined();
    expect(existsSync(join(ws, ".agency", "skills", "summarize", "SKILL.md"))).toBe(true);

    rollbackMarketplacePackage({ workspaceRoot: ws, packageName: "acme/notes" });
    expect(readFileSync(configPath, "utf8")).toBe(beforeBytes);
    expect(existsSync(join(ws, ".agency", "skills", "summarize"))).toBe(false);

    const bus2 = new EventBus();
    const reloaded = await loadPlugins({ workspaceRoot: ws, configDirOverride: userCfg, bus: bus2 });
    expect(reloaded.plugins.some((p) => p.id === "summarize")).toBe(false);
  });

  test("namespace conflict aborts typed with existing tools untouched (real registry)", () => {
    const { ws, pkgDir, store } = setup();
    const b = body();
    makePackage(pkgDir, b, privateKey);
    const pinned = signManifestBody(b, privateKey).publicKey;
    trustMarketplacePackage({ store, packageDir: pkgDir, publicKey: pinned, workspaceRoot: ws });

    const registry = new ToolRegistry();
    registry.register({
      name: "summarize",
      description: "pre-existing tool",
      inputSchema: { type: "object", properties: {} },
      handler: async () => ({ content: "kept", isError: false }),
    });
    const namesBefore = [...registry.names()];

    expectMarketplaceError(
      () => installMarketplacePackage({ workspaceRoot: ws, packageDir: pkgDir, store, registry }),
      "namespace-conflict",
    );
    expect(registry.names()).toEqual(namesBefore);
    expect(registry.get("summarize")).toBeDefined();
    expect(existsSync(join(ws, ".agency", "skills", "summarize"))).toBe(false);
    expect(existsSync(join(ws, ".agency", "marketplace", "installed.json"))).toBe(false);
  });

  test("untrusted install refused by default, nothing written", () => {
    const { ws, pkgDir, store } = setup();
    makePackage(pkgDir, body(), privateKey);
    try {
      installMarketplacePackage({ workspaceRoot: ws, packageDir: pkgDir, store });
      throw new Error("expected refusal");
    } catch (err) {
      expect(err).toBeInstanceOf(ManifestError);
      expect((err as ManifestError).reason).toBe("untrusted-package");
    }
    expect(existsSync(join(ws, ".agency", "skills", "summarize"))).toBe(false);
    expect(existsSync(join(ws, ".agency", "marketplace", "installed.json"))).toBe(false);
  });

  test("pinned key threads trust into validation; wrong key fails closed", () => {
    const { ws, pkgDir, store } = setup();
    const b = body();
    makePackage(pkgDir, b, otherKey);
    trustMarketplacePackage({
      store,
      packageDir: pkgDir,
      publicKey: signManifestBody(b, privateKey).publicKey,
      workspaceRoot: ws,
    });
    try {
      installMarketplacePackage({ workspaceRoot: ws, packageDir: pkgDir, store });
      throw new Error("expected pin mismatch");
    } catch (err) {
      expect(err).toBeInstanceOf(ManifestError);
      expect((err as ManifestError).reason).toBe("invalid-signature");
    }
    expect(existsSync(join(ws, ".agency", "skills", "summarize"))).toBe(false);
  });

  test("malformed lifecycle inputs reject typed", () => {
    const { ws, pkgDir, store } = setup();
    const b = body();
    makePackage(pkgDir, b, privateKey);
    const pinned = signManifestBody(b, privateKey).publicKey;
    trustMarketplacePackage({ store, packageDir: pkgDir, publicKey: pinned, workspaceRoot: ws });

    installMarketplacePackage({ workspaceRoot: ws, packageDir: pkgDir, store });
    expectMarketplaceError(
      () => installMarketplacePackage({ workspaceRoot: ws, packageDir: pkgDir, store }),
      "already-installed",
    );
    expectMarketplaceError(
      () => enableMarketplacePackage({ workspaceRoot: ws, packageName: "acme/missing" }),
      "not-installed",
    );
    expectMarketplaceError(
      () => rollbackMarketplacePackage({ workspaceRoot: ws, packageName: "acme/missing" }),
      "no-snapshot",
    );

    writeFileSync(join(ws, ".agency", "marketplace", "installed.json"), "{not json", "utf8");
    expectMarketplaceError(
      () => enableMarketplacePackage({ workspaceRoot: ws, packageName: "acme/notes" }),
      "corrupt-state",
    );
  });
});
