/**
 * Packs the built desktop app as the npm package `@endeavorai/agency`: `npm i -g @endeavorai/agency`, then `agency [folder]`.
 * The `agency` command updates from npm at launch, so the updater of the installer stays off in this copy.
 * Usage: bun scripts/npm-pack.ts --app <release dir of the tauri build> --out <dir>
 */
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const arg = (flag: string): string => {
  const i = process.argv.indexOf(flag);
  const value = i === -1 ? undefined : process.argv[i + 1];
  if (!value) throw new Error(`missing ${flag}`);
  return value;
};

const app = arg("--app");
const out = arg("--out");
const stage = join(out, "agency");
const { version } = JSON.parse(
  readFileSync(join(import.meta.dir, "..", "src-tauri", "tauri.conf.json"), "utf8"),
);

rmSync(stage, { recursive: true, force: true });
mkdirSync(join(stage, "app"), { recursive: true });
// The sidecar must sit next to the app under its plain name, as in the installed folder.
for (const file of ["agency-desktop.exe", "agency.exe", "WebView2Loader.dll"])
  copyFileSync(join(app, file), join(stage, "app", file));
copyFileSync(join(import.meta.dir, "..", "..", "..", "LICENSE"), join(stage, "LICENSE"));
copyFileSync(join(import.meta.dir, "npm-launcher.cjs"), join(stage, "agency.js"));
writeFileSync(
  join(stage, "package.json"),
  `${JSON.stringify(
    {
      name: "@endeavorai/agency",
      publishConfig: { access: "public" },
      version,
      description: "Agency: a desktop app for coding agents.",
      license: "MIT",
      repository: { type: "git", url: "git+https://github.com/EndeavorAI/Agency.git" },
      bin: { agency: "agency.js" },
      os: ["win32"],
      cpu: ["x64"],
      files: ["agency.js", "app", "LICENSE"],
    },
    null,
    2,
  )}\n`,
);
execFileSync("npm", ["pack", "--pack-destination", out], { cwd: stage, stdio: "inherit", shell: true });
