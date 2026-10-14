import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { TrustStore } from "@agency/guard";
import { AgencyError, ErrorCode } from "@agency/schema";
import { parse as parseJsonc } from "jsonc-parser";
import { type PackageManifestBody, requirePackageTrust, validatePackageManifest } from "./manifest.ts";

// ---------------------------------------------------------------------------
// Marketplace lifecycle (Wave 4B, Todo 24).
//
// Install validates the manifest (Todo 23), snapshots prior plugin+MCP
// config state, and writes through existing paths only: skills land in
// .agency/skills (loadPlugins discovery) and MCP/permissions merge into
// .agency/config.jsonc (loadConfig project layer). No loader redesign.
// ---------------------------------------------------------------------------

/** Typed reasons every lifecycle rejection carries. */
export type MarketplaceIssue =
  | "already-installed"
  | "namespace-conflict"
  | "not-installed"
  | "no-snapshot"
  | "corrupt-state";

/** Typed error for lifecycle rejections. Validation/trust failures throw ManifestError directly. */
export class MarketplaceError extends AgencyError {
  readonly reason: MarketplaceIssue;
  constructor(reason: MarketplaceIssue, message: string, context?: Record<string, unknown>) {
    super(ErrorCode.TOOL_ERROR, message, { source: "market-lifecycle", context: { reason, ...context } });
    this.name = "MarketplaceError";
    this.reason = reason;
  }
}

/** Minimal registry surface install/enable checks (ToolRegistry satisfies this). */
export interface MarketplaceRegistry {
  has(name: string): boolean;
  names(): string[];
}

export const MARKETPLACE_MANIFEST_FILENAME = "agency-package.json";

interface InstalledEntry {
  version: string;
  packageDir: string;
  enabled: boolean;
  skills: string[];
  mcpServers: string[];
  permissions: string[];
  manifest: PackageManifestBody;
  overwrittenMcp?: Record<string, unknown>;
  overwrittenPermissions?: Record<string, unknown>;
}

interface InstallSnapshot {
  packageName: string;
  configExisted: boolean;
  configRaw: string | null;
  createdSkillDirs: string[];
}

function safeName(name: string): string {
  return name.replace(/[^a-zA-Z0-9]/g, "_");
}

function marketplaceDir(workspaceRoot: string): string {
  return join(workspaceRoot, ".agency", "marketplace");
}

function statePath(workspaceRoot: string): string {
  return join(marketplaceDir(workspaceRoot), "installed.json");
}

function pinsPath(workspaceRoot: string): string {
  return join(marketplaceDir(workspaceRoot), "pins.json");
}

function snapshotPath(workspaceRoot: string, packageName: string): string {
  return join(marketplaceDir(workspaceRoot), "snapshots", `${safeName(packageName)}.json`);
}

function projectConfigPath(workspaceRoot: string): string {
  return join(workspaceRoot, ".agency", "config.jsonc");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readJsonFile(path: string): unknown {
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new MarketplaceError("corrupt-state", `marketplace file at ${path} is not valid JSON`, { path });
  }
}

function writeJsonFile(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function readState(workspaceRoot: string): Record<string, InstalledEntry> {
  const raw = readJsonFile(statePath(workspaceRoot));
  if (raw === undefined) return {};
  if (!isRecord(raw)) throw new MarketplaceError("corrupt-state", "marketplace state is not an object");
  return raw as Record<string, InstalledEntry>;
}

function readPins(workspaceRoot: string): Record<string, string> {
  const raw = readJsonFile(pinsPath(workspaceRoot));
  if (raw === undefined) return {};
  if (!isRecord(raw)) throw new MarketplaceError("corrupt-state", "marketplace pins file is not an object");
  return raw as Record<string, string>;
}

function readSnapshot(workspaceRoot: string, packageName: string): InstallSnapshot {
  const path = snapshotPath(workspaceRoot, packageName);
  if (!existsSync(path)) {
    throw new MarketplaceError(
      "no-snapshot",
      `no install snapshot for "${packageName}"; nothing to roll back`,
      {
        packageName,
      },
    );
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new MarketplaceError("corrupt-state", `install snapshot for "${packageName}" is corrupt`, {
      packageName,
    });
  }
  if (
    !isRecord(raw) ||
    typeof raw.packageName !== "string" ||
    typeof raw.configExisted !== "boolean" ||
    (raw.configRaw !== null && typeof raw.configRaw !== "string") ||
    !Array.isArray(raw.createdSkillDirs)
  ) {
    throw new MarketplaceError("corrupt-state", `install snapshot for "${packageName}" has a bad shape`, {
      packageName,
    });
  }
  return raw as unknown as InstallSnapshot;
}

function readProjectConfigRaw(workspaceRoot: string): { existed: boolean; raw: string | null } {
  const path = projectConfigPath(workspaceRoot);
  if (!existsSync(path)) return { existed: false, raw: null };
  return { existed: true, raw: readFileSync(path, "utf8") };
}

function parseProjectConfig(raw: string | null): Record<string, unknown> {
  if (raw === null) return {};
  const errors: unknown[] = [];
  const parsed = parseJsonc(raw, errors as never, { allowTrailingComma: true }) as unknown;
  if (errors.length > 0 || !isRecord(parsed)) {
    throw new MarketplaceError("corrupt-state", "project config is not parseable JSONC; refusing to merge");
  }
  return parsed;
}

function writeProjectConfig(workspaceRoot: string, config: Record<string, unknown>): void {
  const path = projectConfigPath(workspaceRoot);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

/** Trust action: trust the dir and pin the publisher key (TOFU) for later installs. */
export function trustMarketplacePackage(options: {
  store: TrustStore;
  packageDir: string;
  publicKey: string;
  workspaceRoot: string;
}): void {
  options.store.trust(options.packageDir);
  const pins = readPins(options.workspaceRoot);
  pins[resolve(options.packageDir)] = options.publicKey;
  writeJsonFile(pinsPath(options.workspaceRoot), pins);
}

function pinnedKey(workspaceRoot: string, packageDir: string, explicit?: string): string | undefined {
  if (explicit !== undefined) return explicit;
  return readPins(workspaceRoot)[resolve(packageDir)];
}

function readPackageRaw(packageDir: string): unknown {
  const path = join(packageDir, MARKETPLACE_MANIFEST_FILENAME);
  if (!existsSync(path)) {
    throw new MarketplaceError("corrupt-state", `package manifest missing at ${path}`, { packageDir });
  }
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new MarketplaceError("corrupt-state", `package manifest at ${path} is not valid JSON`, {
      packageDir,
    });
  }
}

function checkConflicts(options: {
  body: PackageManifestBody;
  registry?: MarketplaceRegistry;
  existingMcp: Record<string, unknown>;
}): void {
  for (const skill of options.body.skills) {
    if (options.registry?.has(skill.name)) {
      throw new MarketplaceError(
        "namespace-conflict",
        `skill "${skill.name}" collides with a registered tool`,
        {
          skill: skill.name,
        },
      );
    }
  }
  for (const name of Object.keys(options.body.mcpServers)) {
    if (name in options.existingMcp) {
      throw new MarketplaceError("namespace-conflict", `MCP server "${name}" already configured`, {
        server: name,
      });
    }
    if (options.registry?.has(name) || options.registry?.names().some((n) => n.startsWith(`${name}_`))) {
      throw new MarketplaceError(
        "namespace-conflict",
        `MCP server "${name}" collides with a registered tool`,
        {
          server: name,
        },
      );
    }
  }
}

export interface InstallMarketplaceOptions {
  workspaceRoot: string;
  packageDir: string;
  store: TrustStore;
  registry?: MarketplaceRegistry;
  /** Explicit pin wins; otherwise the key pinned at trust time applies (TOFU). */
  expectedPublicKey?: string;
  explicitTrust?: boolean;
}

export interface MarketplaceReceipt {
  packageName: string;
  version: string;
  skills: string[];
  mcpServers: string[];
  enabled: false;
}

/** Install: validate, snapshot prior state, copy skills, record disabled state. */
export function installMarketplacePackage(options: InstallMarketplaceOptions): MarketplaceReceipt {
  requirePackageTrust({
    store: options.store,
    packageDir: options.packageDir,
    explicitTrust: options.explicitTrust,
  });
  const raw = readPackageRaw(options.packageDir);
  const { manifest: body } = validatePackageManifest(
    raw,
    { expectedPublicKey: pinnedKey(options.workspaceRoot, options.packageDir, options.expectedPublicKey) },
    { store: options.store, packageDir: options.packageDir, explicitTrust: options.explicitTrust },
  );
  const state = readState(options.workspaceRoot);
  if (state[body.name]) {
    throw new MarketplaceError("already-installed", `package "${body.name}" is already installed`, {
      packageName: body.name,
    });
  }
  const configPrev = readProjectConfigRaw(options.workspaceRoot);
  const existingMcp = isRecord(parseProjectConfig(configPrev.raw).mcpServers)
    ? (parseProjectConfig(configPrev.raw).mcpServers as Record<string, unknown>)
    : {};
  checkConflicts({ body, registry: options.registry, existingMcp });
  for (const skill of body.skills) {
    if (existsSync(join(options.workspaceRoot, ".agency", "skills", skill.name))) {
      throw new MarketplaceError("namespace-conflict", `skill directory "${skill.name}" already exists`, {
        skill: skill.name,
      });
    }
  }
  const createdSkillDirs: string[] = [];
  try {
    for (const skill of body.skills) {
      const src = join(options.packageDir, skill.path);
      if (!existsSync(src)) {
        throw new MarketplaceError("corrupt-state", `skill file missing in package: ${skill.path}`, {
          skill: skill.name,
        });
      }
      const targetDir = join(options.workspaceRoot, ".agency", "skills", skill.name);
      mkdirSync(targetDir, { recursive: true });
      writeFileSync(join(targetDir, "SKILL.md"), readFileSync(src, "utf8"), "utf8");
      createdSkillDirs.push(skill.name);
    }
  } catch (err) {
    for (const name of createdSkillDirs) {
      rmSync(join(options.workspaceRoot, ".agency", "skills", name), { recursive: true, force: true });
    }
    throw err;
  }
  const snapshot: InstallSnapshot = {
    packageName: body.name,
    configExisted: configPrev.existed,
    configRaw: configPrev.raw,
    createdSkillDirs,
  };
  mkdirSync(dirname(snapshotPath(options.workspaceRoot, body.name)), { recursive: true });
  writeFileSync(
    snapshotPath(options.workspaceRoot, body.name),
    `${JSON.stringify(snapshot, null, 2)}\n`,
    "utf8",
  );
  state[body.name] = {
    version: body.version,
    packageDir: options.packageDir,
    enabled: false,
    skills: body.skills.map((s) => s.name),
    mcpServers: Object.keys(body.mcpServers),
    permissions: Object.keys(body.permissions),
    manifest: body,
  };
  writeJsonFile(statePath(options.workspaceRoot), state);
  return {
    packageName: body.name,
    version: body.version,
    skills: body.skills.map((s) => s.name),
    mcpServers: Object.keys(body.mcpServers),
    enabled: false as const,
  };
}

/** Enable: merge MCP/permissions into the project config layer without reinstalling files. */
export function enableMarketplacePackage(options: {
  workspaceRoot: string;
  packageName: string;
  registry?: MarketplaceRegistry;
}): void {
  const state = readState(options.workspaceRoot);
  const entry = state[options.packageName];
  if (!entry) {
    throw new MarketplaceError("not-installed", `package "${options.packageName}" is not installed`, {
      packageName: options.packageName,
    });
  }
  if (entry.enabled) return;
  if (!isRecord(entry.manifest) || typeof entry.manifest.version !== "string") {
    throw new MarketplaceError("corrupt-state", `installed state for "${options.packageName}" is corrupt`, {
      packageName: options.packageName,
    });
  }
  const config = parseProjectConfig(readProjectConfigRaw(options.workspaceRoot).raw);
  const existingMcp = isRecord(config.mcpServers) ? (config.mcpServers as Record<string, unknown>) : {};
  checkConflicts({ body: entry.manifest as PackageManifestBody, registry: options.registry, existingMcp });
  const overwrittenMcp: Record<string, unknown> = {};
  const mergedMcp: Record<string, unknown> = { ...existingMcp };
  for (const [name, server] of Object.entries((entry.manifest as PackageManifestBody).mcpServers)) {
    if (name in mergedMcp) overwrittenMcp[name] = mergedMcp[name];
    mergedMcp[name] = server;
  }
  const existingPerms = isRecord(config.permissions) ? (config.permissions as Record<string, unknown>) : {};
  const overwrittenPermissions: Record<string, unknown> = {};
  const mergedPerms: Record<string, unknown> = { ...existingPerms };
  for (const [key, value] of Object.entries((entry.manifest as PackageManifestBody).permissions)) {
    if (key in mergedPerms) overwrittenPermissions[key] = mergedPerms[key];
    mergedPerms[key] = value;
  }
  if (Object.keys(mergedMcp).length > 0) config.mcpServers = mergedMcp;
  if (Object.keys(mergedPerms).length > 0) config.permissions = mergedPerms;
  writeProjectConfig(options.workspaceRoot, config);
  entry.enabled = true;
  entry.overwrittenMcp = overwrittenMcp;
  entry.overwrittenPermissions = overwrittenPermissions;
  writeJsonFile(statePath(options.workspaceRoot), state);
}

/** Disable: remove the package's config contributions, restoring overwritten values. */
export function disableMarketplacePackage(options: { workspaceRoot: string; packageName: string }): void {
  const state = readState(options.workspaceRoot);
  const entry = state[options.packageName];
  if (!entry) {
    throw new MarketplaceError("not-installed", `package "${options.packageName}" is not installed`, {
      packageName: options.packageName,
    });
  }
  if (!entry.enabled) return;
  const config = parseProjectConfig(readProjectConfigRaw(options.workspaceRoot).raw);
  if (isRecord(config.mcpServers)) {
    const mcp = { ...(config.mcpServers as Record<string, unknown>) };
    for (const name of entry.mcpServers) delete mcp[name];
    Object.assign(mcp, entry.overwrittenMcp ?? {});
    if (Object.keys(mcp).length > 0) config.mcpServers = mcp;
    else delete config.mcpServers;
  }
  if (isRecord(config.permissions)) {
    const perms = { ...(config.permissions as Record<string, unknown>) };
    for (const key of entry.permissions) delete perms[key];
    Object.assign(perms, entry.overwrittenPermissions ?? {});
    config.permissions = perms;
  }
  writeProjectConfig(options.workspaceRoot, config);
  entry.enabled = false;
  delete entry.overwrittenMcp;
  delete entry.overwrittenPermissions;
  writeJsonFile(statePath(options.workspaceRoot), state);
}

/** Rollback: restore the exact prior config bytes and remove installed files/state. */
export function rollbackMarketplacePackage(options: { workspaceRoot: string; packageName: string }): void {
  const snapshot = readSnapshot(options.workspaceRoot, options.packageName);
  const configPath = projectConfigPath(options.workspaceRoot);
  if (snapshot.configRaw === null || !snapshot.configExisted) {
    if (existsSync(configPath)) rmSync(configPath);
  } else {
    mkdirSync(dirname(configPath), { recursive: true });
    writeFileSync(configPath, snapshot.configRaw, "utf8");
  }
  for (const name of snapshot.createdSkillDirs) {
    rmSync(join(options.workspaceRoot, ".agency", "skills", name), { recursive: true, force: true });
  }
  const state = readState(options.workspaceRoot);
  delete state[options.packageName];
  if (Object.keys(state).length === 0) {
    // No packages remain: remove the state file so rollback restores the
    // exact prior tree instead of leaving an empty installed.json behind.
    // (readState treats a missing file as {} — Todo 25 adversarial fixture.)
    rmSync(statePath(options.workspaceRoot), { force: true });
  } else {
    writeJsonFile(statePath(options.workspaceRoot), state);
  }
  rmSync(snapshotPath(options.workspaceRoot, options.packageName), { force: true });
}
