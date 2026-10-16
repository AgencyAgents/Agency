/**
 * Puts the agency binary where Tauri bundles it: src-tauri/binaries/agency-<rust target triple>[.exe].
 * Usage: bun scripts/sidecar.ts [--version 0.1.0] [--from <prebuilt binary>]
 */
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";

const repo = resolve(import.meta.dir, "..", "..", "..");
const arg = (flag: string): string | undefined => {
  const i = process.argv.indexOf(flag);
  return i === -1 ? undefined : process.argv[i + 1];
};

const triple = /^host: (\S+)$/m.exec(execFileSync("rustc", ["-vV"], { encoding: "utf8" }))?.[1];
if (!triple) throw new Error("rustc -vV printed no host triple");
const exe = process.platform === "win32" ? ".exe" : "";
const bunTarget = `bun-${process.platform === "win32" ? "windows" : process.platform}-${process.arch}`;
const built = join(repo, "dist", `agency-${bunTarget.slice(4)}${exe}`);

let from = arg("--from");
if (from === undefined) {
  const version = arg("--version") ?? "0.1.0";
  execFileSync(
    "bun",
    ["scripts/build.ts", "--targets", bunTarget, "--version", version, "--outdir", "dist"],
    {
      cwd: repo,
      stdio: "inherit",
    },
  );
  from = built;
}
if (!existsSync(from)) throw new Error(`no agency binary at ${from}`);

const dir = join(import.meta.dir, "..", "src-tauri", "binaries");
mkdirSync(dir, { recursive: true });
const to = join(dir, `agency-${triple}${exe}`);
copyFileSync(from, to);
console.log(`sidecar: ${to}`);
