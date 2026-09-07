/**
 * Generates a CycloneDX 1.5 SBOM from bun.lock — no external tooling, so the
 * release pipeline adds no supply-chain surface of its own. Components cover
 * every resolved package (runtime and build-time: both are audit-relevant)
 * plus the workspace packages, with the sha512 integrity hashes from the
 * lockfile attached.
 *
 * With --reproducible the output is byte-identical for the same lockfile:
 * no timestamp, and the serial number is derived from the document content.
 *
 * Usage: bun scripts/sbom.ts [--lockfile bun.lock] [--out dist/agency.cdx.json] [--reproducible]
 */
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { parse as parseJsonc } from "jsonc-parser";

export interface SbomOptions {
  name: string;
  version: string;
  reproducible?: boolean;
  now?: Date;
}

interface WorkspaceEntry {
  name?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

interface BunLock {
  workspaces: Record<string, WorkspaceEntry>;
  packages: Record<string, unknown[]>;
}

interface Component {
  type: "application" | "library";
  "bom-ref": string;
  name: string;
  version?: string;
  purl: string;
  hashes?: Array<{ alg: string; content: string }>;
}

/** packageurl for npm: the scope's "@" is percent-encoded, the inner slash stays. */
export function purl(name: string, version: string): string {
  const encoded = name.startsWith("@") ? `%40${name.slice(1)}` : name;
  return `pkg:npm/${encoded}@${version}`;
}

/** Resolved version from a lockfile key like "zod@4.5.4" or "@agency/cli@workspace:packages/cli". */
export function resolvedVersion(key: string): string {
  return key.slice(key.lastIndexOf("@") + 1);
}

function sha512Hex(integrity: string): string {
  return Buffer.from(integrity.replace(/^sha512-/, ""), "base64").toString("hex");
}

/** RFC 4122 name-based UUID (SHA-1), so the serial is stable for identical content. */
function uuidv5(name: string, namespace: string): string {
  const nsHex = namespace.replace(/-/g, "");
  const nsBytes = Buffer.from(nsHex, "hex");
  const digest = createHash("sha1").update(nsBytes).update(name, "utf8").digest();
  const bytes = Buffer.from(digest.subarray(0, 16));
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x50;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const UUID_NAMESPACE = "6f5a2c3e-8b1d-4a7e-9c0f-3d2b1a4e5f60";

interface Dependency {
  ref: string;
  dependsOn: string[];
}

export interface Bom {
  bomFormat: string;
  specVersion: string;
  version: number;
  serialNumber?: string;
  metadata: Record<string, unknown>;
  components: Component[];
  dependencies: Dependency[];
}

export function generateSbom(lock: BunLock, opts: SbomOptions): Bom {
  const rootRef = purl(opts.name, opts.version);

  // Workspace packages ship at the release version (the monorepo cuts all
  // packages together), so their refs are stable per release.
  const workspaceRefs = new Map<string, string>();
  for (const [dir, ws] of Object.entries(lock.workspaces)) {
    if (dir === "" || !ws.name) continue;
    workspaceRefs.set(ws.name, purl(ws.name, opts.version));
  }

  const externalRefs = new Map<string, string>();
  const externalMeta = new Map<string, Record<string, unknown>>();
  const components: Component[] = [];
  for (const [name, entry] of Object.entries(lock.packages)) {
    // Lockfile keys are bare package names; entry[0] is "name@version".
    const first = entry[0];
    if (typeof first !== "string") continue;
    const version = resolvedVersion(first);
    if (version.startsWith("workspace:")) continue;
    if (workspaceRefs.has(name)) continue;
    const ref = purl(name, version);
    externalRefs.set(name, ref);

    const meta = entry.find((v): v is Record<string, unknown> => typeof v === "object" && v !== null);
    if (meta) externalMeta.set(name, meta);

    const component: Component = { type: "library", "bom-ref": ref, name, version, purl: ref };
    const integrity = [...entry]
      .reverse()
      .find((v): v is string => typeof v === "string" && v.startsWith("sha512-"));
    if (integrity) {
      component.hashes = [{ alg: "SHA-512", content: sha512Hex(integrity) }];
    }
    components.push(component);
  }

  for (const [name, ref] of workspaceRefs) {
    components.push({ type: "application", "bom-ref": ref, name, version: opts.version, purl: ref });
  }
  components.sort((a, b) => a["bom-ref"].localeCompare(b["bom-ref"]));

  const resolveDep = (name: string): string | undefined => workspaceRefs.get(name) ?? externalRefs.get(name);

  const dependsOn = (deps: Record<string, string> | undefined): string[] =>
    Object.keys(deps ?? {})
      .map(resolveDep)
      .filter((ref): ref is string => typeof ref === "string")
      .sort();

  const dependencies: Dependency[] = [];
  const rootWs = lock.workspaces[""];
  dependencies.push({
    ref: rootRef,
    dependsOn: [...new Set([...dependsOn(rootWs?.dependencies), ...workspaceRefs.values()])].sort(),
  });
  for (const [dir, ws] of Object.entries(lock.workspaces)) {
    if (dir === "" || !ws.name) continue;
    const ref = workspaceRefs.get(ws.name);
    if (ref) dependencies.push({ ref, dependsOn: dependsOn({ ...ws.dependencies, ...ws.devDependencies }) });
  }
  for (const [name, ref] of externalRefs) {
    const meta = externalMeta.get(name);
    const metaDeps = (meta?.dependencies ?? {}) as Record<string, string>;
    dependencies.push({ ref, dependsOn: dependsOn(metaDeps) });
  }
  dependencies.sort((a, b) => a.ref.localeCompare(b.ref));

  const bom: Bom = {
    bomFormat: "CycloneDX",
    specVersion: "1.5",
    version: 1,
    metadata: {
      ...(opts.reproducible ? {} : { timestamp: (opts.now ?? new Date()).toISOString() }),
      tools: [{ vendor: "agency", name: "agency-sbom", version: opts.version }],
      component: { type: "application", "bom-ref": rootRef, name: opts.name, version: opts.version },
    },
    components,
    dependencies,
  };

  if (opts.reproducible) {
    const content = JSON.stringify({ ...bom, serialNumber: undefined });
    bom.serialNumber = `urn:uuid:${uuidv5(content, UUID_NAMESPACE)}`;
  } else {
    bom.serialNumber = `urn:uuid:${randomUUID()}`;
  }
  return bom;
}

function packageMeta(): { name: string; version: string } {
  const pkg = JSON.parse(readFileSync("package.json", "utf8")) as { name?: string; version?: string };
  return { name: pkg.name ?? "agency", version: pkg.version ?? "0.0.0" };
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  let lockfile = "bun.lock";
  let out = "";
  let reproducible = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--lockfile") {
      lockfile = argv[i + 1] ?? lockfile;
      i++;
    } else if (argv[i] === "--out") {
      out = argv[i + 1] ?? "";
      i++;
    } else if (argv[i] === "--reproducible") reproducible = true;
    else {
      process.stderr.write(`error: unknown option ${argv[i]}\n`);
      return 1;
    }
  }

  const meta = packageMeta();
  // bun.lock is JSONC (trailing commas), not strict JSON.
  const lock = parseJsonc(readFileSync(lockfile, "utf8")) as BunLock;
  const bom = generateSbom(lock, { name: meta.name, version: meta.version, reproducible });
  const json = `${JSON.stringify(bom, null, 2)}\n`;

  if (out) {
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, json);
    process.stdout.write(`SBOM written to ${out} (${bom.components.length} components)\n`);
  } else {
    process.stdout.write(json);
  }
  return 0;
}

if (import.meta.main) process.exitCode = await main();
