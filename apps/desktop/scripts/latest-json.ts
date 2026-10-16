/**
 * Writes the Tauri updater feed for one release from the NSIS bundle and its .sig.
 * Usage: bun scripts/latest-json.ts --version 0.1.1 --bundle <dir> --out <file> [--base-url <url>]
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const arg = (flag: string): string | undefined => {
  const i = process.argv.indexOf(flag);
  return i === -1 ? undefined : process.argv[i + 1];
};
const need = (flag: string): string => {
  const value = arg(flag);
  if (!value) throw new Error(`missing ${flag}`);
  return value;
};

const version = need("--version");
const bundle = need("--bundle");
const out = need("--out");
const base = arg("--base-url") ?? `https://github.com/AgencyHarness/Agency/releases/download/v${version}`;

const installer = readdirSync(bundle).find((f) => f.endsWith("-setup.exe") && f.includes(`_${version}_`));
if (!installer) throw new Error(`no ${version} setup.exe in ${bundle}`);
const signature = readFileSync(join(bundle, `${installer}.sig`), "utf8").trim();

const feed = {
  version,
  notes: `Agency ${version}`,
  pub_date: new Date().toISOString(),
  platforms: {
    "windows-x86_64": { signature, url: `${base}/${encodeURIComponent(installer)}` },
  },
};
writeFileSync(out, `${JSON.stringify(feed, null, 2)}\n`);
console.log(`latest.json: ${installer}`);
