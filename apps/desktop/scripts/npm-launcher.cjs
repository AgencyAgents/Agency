#!/usr/bin/env node
// The `agency` command of the npm package: installs a newer version from npm, then opens the app.
// The update runs before the app starts, since Windows locks the files of a running app.
const { execSync, spawn } = require("node:child_process");
const { join, resolve } = require("node:path");

const current = require("./package.json").version;
const newer = (a, b) => {
  const [x, y] = [a, b].map((v) => v.split(/[.-]/).map(Number));
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i];
  return false;
};
// npx runs a copy that a global install would not replace.
if (!process.env.AGENCY_NO_UPDATE && !__dirname.includes("_npx")) {
  try {
    const opts = { encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"] };
    const latest = execSync("npm view agencyharness version", opts).trim();
    if (newer(latest, current)) {
      console.log(`Updating Agency ${current} to ${latest}`);
      execSync(`npm install -g agencyharness@${latest}`, { stdio: "inherit" });
    }
  } catch {
    // Offline, or the app runs and holds its files: open the version that is here.
  }
}
const args = process.argv.slice(2).map((a) => (a.startsWith("-") ? a : resolve(a)));
spawn(join(__dirname, "app", "agency-desktop.exe"), args, { detached: true, stdio: "ignore" }).unref();
