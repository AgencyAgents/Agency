/**
 * Installs an old build, serves a newer signed one on a local feed, and checks the app updates itself.
 * Both builds need plugins.updater.dangerousInsecureTransportProtocol, since the feed is plain http.
 * Usage: bun scripts/update-e2e.ts --old <old setup.exe> --new <new setup.exe> --version <new version> [--shot <png>]
 */
import { execFileSync, spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

const need = (flag: string): string => {
  const i = process.argv.indexOf(flag);
  const value = i === -1 ? undefined : process.argv[i + 1];
  if (!value) throw new Error(`missing ${flag}`);
  return value;
};
const oldSetup = resolve(need("--old"));
const newSetup = resolve(need("--new"));
const version = need("--version");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const work = mkdtempSync(join(tmpdir(), "agency-update-e2e-"));
const instDir = join(work, "app");
const home = join(work, "home");
mkdirSync(join(home, "config"), { recursive: true });

let served = 0;
let feedHits = 0;
const server = http.createServer((req, res) => {
  if (req.url === "/latest.json") {
    feedHits++;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(readFileSync(join(work, "latest.json")));
    return;
  }
  if (req.url === `/${encodeURIComponent(basename(newSetup))}`) {
    const body = readFileSync(newSetup);
    served += body.length;
    res.writeHead(200, { "content-type": "application/octet-stream", "content-length": body.length });
    res.end(body);
    return;
  }
  res.writeHead(404).end();
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
execFileSync(
  "bun",
  [
    join(import.meta.dir, "latest-json.ts"),
    "--version",
    version,
    "--bundle",
    dirname(newSetup),
    "--out",
    join(work, "latest.json"),
    "--base-url",
    origin,
  ],
  { stdio: "inherit" },
);

const port = 9800 + Math.floor(Math.random() * 100);
const checks: [string, boolean][] = [];
const check = (name: string, ok: boolean) => {
  checks.push([name, ok]);
  console.log(`${ok ? "PASS" : "FAIL"} ${name}`);
};

async function page(ms: number): Promise<WebSocket | null> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      const list = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()) as {
        type: string;
        webSocketDebuggerUrl: string;
      }[];
      const target = list.find((t) => t.type === "page");
      if (target) {
        const sock = new WebSocket(target.webSocketDebuggerUrl);
        await new Promise((r, j) => {
          sock.onopen = r;
          sock.onerror = j;
        });
        return sock;
      }
    } catch {}
    await sleep(100);
  }
  return null;
}
let nextId = 1;
function ev<T>(sock: WebSocket, expression: string): Promise<T | undefined> {
  return new Promise((r) => {
    const id = nextId++;
    const onMessage = (m: MessageEvent) => {
      const msg = JSON.parse(String(m.data));
      if (msg.id !== id) return;
      sock.removeEventListener("message", onMessage);
      r(msg.result?.result?.value as T);
    };
    sock.addEventListener("message", onMessage);
    sock.addEventListener("close", () => r(undefined));
    sock.send(
      JSON.stringify({
        id,
        method: "Runtime.evaluate",
        params: { expression, awaitPromise: true, returnByValue: true },
      }),
    );
  });
}
/** The page target exists before the app's scripts run, so the first reads can come back empty. */
async function appVersion(sock: WebSocket): Promise<string | undefined> {
  for (let i = 0; i < 50 && sock.readyState === WebSocket.OPEN; i++) {
    const v = await ev<string>(sock, `window.__TAURI_INTERNALS__?.invoke("plugin:app|version")`);
    if (v) return v;
    await sleep(100);
  }
  return undefined;
}

function mainExe(): string {
  const exe = readdirSync(instDir).find((f) => f.endsWith(".exe") && !/^(uninstall|agency)\.exe$/i.test(f));
  if (!exe) throw new Error(`no app binary in ${instDir}`);
  return join(instDir, exe);
}
function kill(image: string): void {
  try {
    execFileSync("taskkill", ["/F", "/T", "/IM", image], { stdio: "ignore" });
  } catch {}
}

try {
  execFileSync(oldSetup, ["/S", `/D=${instDir}`], { stdio: "inherit" });
  const exe = mainExe();
  check("old build installs to the chosen folder", existsSync(exe));
  spawn(exe, [], {
    detached: true,
    stdio: "ignore",
    env: {
      ...process.env,
      AGENCY_HOME: home,
      AGENCY_AGENTS_HOME: home,
      AGENCY_UPDATE_URL: `${origin}/latest.json`,
      WEBVIEW2_USER_DATA_FOLDER: join(work, "webview"),
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}`,
    },
  }).unref();

  const first = await page(60_000);
  if (!first) throw new Error("the old build opened no page");
  const oldVersion = await appVersion(first);
  check(`old build runs as an older version (${oldVersion})`, !!oldVersion && oldVersion !== version);
  let screen = false;
  const end = Date.now() + 30_000;
  while (!screen && Date.now() < end && first.readyState === WebSocket.OPEN) {
    const text = await ev<string>(first, "document.body.innerText");
    screen =
      !!text?.includes(`Updating Agency to ${version}`) || !!text?.includes(`Installing Agency ${version}`);
    if (!screen) await sleep(50);
  }
  check("the update screen shows the new version", screen);
  const shotFile = process.argv.includes("--shot")
    ? process.argv[process.argv.indexOf("--shot") + 1]
    : undefined;
  if (screen && shotFile) {
    const png = await new Promise<string | undefined>((r) => {
      const onMessage = (m: MessageEvent) => {
        const msg = JSON.parse(String(m.data));
        if (msg.id !== -1) return;
        first.removeEventListener("message", onMessage);
        r(msg.result?.data);
      };
      first.addEventListener("message", onMessage);
      first.send(JSON.stringify({ id: -1, method: "Page.captureScreenshot", params: { format: "png" } }));
    });
    if (png) writeFileSync(shotFile, Buffer.from(png, "base64"));
  }
  check("the feed was read", feedHits > 0);

  const closed = Date.now() + 120_000;
  while (first.readyState === WebSocket.OPEN && Date.now() < closed) await sleep(200);
  check("the old build exits for the installer", first.readyState !== WebSocket.OPEN);
  check("the signed installer was downloaded", served === statSync(newSetup).size);

  let relaunched: string | undefined;
  const back = Date.now() + 180_000;
  while (relaunched !== version && Date.now() < back) {
    const sock = await page(5_000);
    if (sock) {
      relaunched = await appVersion(sock);
      if (relaunched === version) {
        const text = (await ev<string>(sock, "document.body.innerText")) ?? "";
        check("the new build opens the app, not the update screen", !text.includes("Updating Agency"));
      }
      sock.close();
    }
    if (relaunched !== version) await sleep(500);
  }
  check(`the app relaunches as ${version} (saw ${relaunched})`, relaunched === version);
} catch (error) {
  console.log(`FAIL ${error}`);
  checks.push(["no error", false]);
} finally {
  const exeName = existsSync(instDir) ? basename(mainExe()) : "";
  if (exeName) kill(exeName);
  const uninstaller = join(instDir, "uninstall.exe");
  if (existsSync(uninstaller)) {
    try {
      execFileSync(uninstaller, ["/S"], { stdio: "inherit" });
    } catch {}
    await sleep(3000);
  }
  server.close();
}

const failed = checks.filter(([, ok]) => !ok).length;
console.log(`\n${checks.length - failed} passed, ${failed} failed`);
if (failed === 0) rmSync(work, { recursive: true, force: true });
else console.log(`kept ${work}`);
process.exit(failed === 0 ? 0 : 1);
