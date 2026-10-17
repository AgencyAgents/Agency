#!/usr/bin/env node
// The `agency` command of the npm package: installs a newer version from npm, then opens the app.
// The update runs while the app is closed, since Windows locks the files of a running program.
// `--after <pid> --to <version>` is how the app hands an update over before it quits.
const { execSync, spawn } = require("node:child_process");
const { closeSync, existsSync, openSync } = require("node:fs");
const { join, resolve } = require("node:path");

const app = join(__dirname, "app", "agency-desktop.exe");
const daemon = join(__dirname, "app", "agency.exe");
const current = require("./package.json").version;
const flag = (name) => {
  const i = process.argv.indexOf(name);
  return i === -1 ? undefined : process.argv[i + 1];
};
const newer = (a, b) => {
  const [x, y] = [a, b].map((v) => v.split(/[.-]/).map(Number));
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i];
  return false;
};
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const running = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code !== "ESRCH";
  }
};
const unlocked = (file) => {
  try {
    closeSync(openSync(file, "r+"));
    return true;
  } catch {
    return false;
  }
};

/** The Start menu entry opens the app itself, which then updates through this command. */
function shortcut() {
  const lnk = join(process.env.APPDATA ?? "", "Microsoft", "Windows", "Start Menu", "Programs", "Agency.lnk");
  if (!process.env.APPDATA || existsSync(lnk)) return;
  const ps = `$s=(New-Object -ComObject WScript.Shell).CreateShortcut('${lnk}');$s.TargetPath='${app}';$s.Save()`;
  try {
    execSync(`powershell -NoProfile -Command "${ps}"`, { stdio: "ignore", windowsHide: true });
  } catch {}
}

function install(version, quiet) {
  // The version goes into a shell command.
  if (!/^\d+\.\d+\.\d+[\w.-]*$/.test(version)) throw new Error(`bad version ${version}`);
  execSync(`npm install -g agencyharness@${version}`, {
    stdio: quiet ? "ignore" : "inherit",
    windowsHide: true,
  });
}

const after = Number(flag("--after"));
const to = flag("--to");
if (after > 0 && to) {
  // The app has quit or is quitting; its daemons leave about two seconds after it.
  for (let i = 0; i < 300 && (running(after) || !unlocked(daemon) || !unlocked(app)); i++) sleep(100);
  try {
    install(to, true);
  } catch {
    // The old version opens: better than no app.
  }
} else if (!process.env.AGENCY_NO_UPDATE && !__dirname.includes("_npx")) {
  try {
    const opts = { encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"], windowsHide: true };
    const latest = execSync("npm view agencyharness version", opts).trim();
    if (newer(latest, current)) {
      console.log(`Updating Agency ${current} to ${latest}`);
      install(latest, false);
    }
  } catch {
    // Offline, or the app runs and holds its files: open the version that is here.
  }
}
shortcut();
const args = process.argv
  .slice(2)
  .filter((_, i, all) => !["--after", "--to"].includes(all[i]) && !["--after", "--to"].includes(all[i - 1]))
  .map((a) => (a.startsWith("-") ? a : resolve(a)));
spawn(app, args, { detached: true, stdio: "ignore" }).unref();
