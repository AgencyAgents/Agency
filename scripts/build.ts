/**
 * Compiles the `agency` binary with Bun (--compile) and enforces the release
 * size budget. Cross-compilation targets use Bun's `bun-<os>-<arch>` names;
 * each target produces `agency-<os>-<arch>[.exe]` in the output directory.
 *
 * The budget default sits just above Bun 1.4's own ~90 MB Windows runtime
 * floor (the app bundle itself is ~1 MB); it exists to catch regressions, not
 * to fight the runtime. Override with --max-size-mb.
 *
 * Usage: bun scripts/build.ts [--targets bun-linux-x64,bun-darwin-arm64] [--version 0.1.0] [--outdir dist] [--max-size-mb 100]
 */
import { mkdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const DEFAULT_SIZE_BUDGET_MB = 100;
const ENTRYPOINT = "packages/cli/src/entrypoint.ts";

/** Bun compile target -> release artifact name. */
const TARGETS: Record<string, string> = {
  "bun-linux-x64": "agency-linux-x64",
  "bun-linux-arm64": "agency-linux-arm64",
  "bun-darwin-x64": "agency-darwin-x64",
  "bun-darwin-arm64": "agency-darwin-arm64",
  "bun-windows-x64": "agency-windows-x64.exe",
};

function currentTarget(): string {
  const os = process.platform === "win32" ? "windows" : process.platform;
  const target = `bun-${os}-${process.arch}`;
  if (!(target in TARGETS)) {
    throw new Error(`no release target for ${process.platform}-${process.arch}`);
  }
  return target;
}

function packageVersion(): string {
  const pkg = JSON.parse(readFileSync("package.json", "utf8")) as { version?: string };
  return pkg.version ?? "0.0.0";
}

interface Options {
  targets: string[];
  version: string;
  outdir: string;
  maxSizeMb: number;
}

function parseArgs(argv: string[]): Options {
  let targets: string[] = [];
  let version = "";
  let outdir = "dist";
  let maxSizeMb = DEFAULT_SIZE_BUDGET_MB;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--targets") {
      targets = (argv[i + 1] ?? "")
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean);
      i++;
    } else if (arg === "--version") {
      version = (argv[i + 1] ?? "").replace(/^v/, "");
      i++;
    } else if (arg === "--outdir") {
      outdir = argv[i + 1] ?? "dist";
      i++;
    } else if (arg === "--max-size-mb") {
      maxSizeMb = Number(argv[i + 1] ?? DEFAULT_SIZE_BUDGET_MB);
      i++;
    } else {
      throw new Error(`unknown option: ${arg}`);
    }
  }

  if (targets.length === 0) targets = [currentTarget()];
  for (const target of targets) {
    if (!(target in TARGETS)) {
      throw new Error(`unknown target "${target}" (known: ${Object.keys(TARGETS).join(", ")})`);
    }
  }
  return { targets, version: version || packageVersion(), outdir, maxSizeMb };
}

async function compile(target: string, outfile: string, version: string): Promise<void> {
  // The version is inlined at compile time; running from source falls back to
  // the entrypoint's own default (see entrypoint.ts).
  // AGENCY_UPDATE_PUBLIC_KEY (SPKI DER base64) is inlined the same way so the
  // production public key is embedded in the binary; without it the dev key
  // in update-public-key.ts applies (dev builds only).
  const defineVersion = `process.env.AGENCY_VERSION=${JSON.stringify(version)}`;
  const updateKey = process.env.AGENCY_UPDATE_PUBLIC_KEY?.trim();
  const defineKey =
    updateKey !== undefined && updateKey.length > 0
      ? `process.env.AGENCY_UPDATE_PUBLIC_KEY=${JSON.stringify(updateKey)}`
      : undefined;
  const proc = Bun.spawn(
    [
      process.execPath,
      "build",
      "--compile",
      "--minify",
      "--sourcemap=none",
      "--define",
      defineVersion,
      ...(defineKey !== undefined ? (["--define", defineKey] as const) : []),
      `--target=${target}`,
      `--outfile=${outfile}`,
      ENTRYPOINT,
    ],
    { stdout: "inherit", stderr: "inherit" },
  );
  const code = await proc.exited;
  if (code !== 0) throw new Error(`bun build failed for ${target} (exit ${code})`);
}

function formatMb(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

async function main(): Promise<number> {
  const { targets, version, outdir, maxSizeMb } = parseArgs(process.argv.slice(2));
  const budgetBytes = maxSizeMb * 1024 * 1024;
  mkdirSync(outdir, { recursive: true });

  const failures: string[] = [];
  for (const target of targets) {
    const artifact = TARGETS[target];
    if (!artifact) throw new Error(`unknown target "${target}"`);
    const outfile = join(outdir, artifact);
    process.stdout.write(`Building ${target} -> ${outfile}\n`);
    try {
      await compile(target, outfile, version);
    } catch (error) {
      failures.push(`${target}: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    const size = statSync(outfile).size;
    if (size > budgetBytes) {
      failures.push(`${target}: ${formatMb(size)} exceeds the ${formatMb(budgetBytes)} budget`);
    } else {
      process.stdout.write(`  ${formatMb(size)} (budget ${formatMb(budgetBytes)})\n`);
    }
  }

  if (failures.length > 0) {
    for (const failure of failures) process.stderr.write(`error: ${failure}\n`);
    return 1;
  }
  return 0;
}

process.exitCode = await main();
