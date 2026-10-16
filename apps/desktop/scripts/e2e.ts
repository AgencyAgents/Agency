/**
 * Drives the built app over WebView2 CDP against the real daemon and a fake OpenAI server.
 * Usage: bun scripts/e2e.ts [--app <path to agency-desktop.exe>] [--keep]
 */
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const arg = (flag: string): string | undefined => {
  const i = process.argv.indexOf(flag);
  return i === -1 ? undefined : process.argv[i + 1];
};
const app = resolve(
  arg("--app") ?? join(import.meta.dir, "..", "src-tauri", "target", "release", "agency-desktop.exe"),
);
if (!existsSync(app)) throw new Error(`no app at ${app}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const fake = { requests: 0, aborted: 0 };
const chunk = (delta: object, finish: string | null = null) =>
  `data: ${JSON.stringify({ id: "c", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
const server = http.createServer(async (req, res) => {
  if (!req.url?.startsWith("/v1/")) {
    res.writeHead(204).end();
    return;
  }
  let body = "";
  for await (const c of req) body += c;
  fake.requests++;
  const messages = (JSON.parse(body || "{}").messages ?? []) as { role: string; content: unknown }[];
  const last = messages.at(-1);
  const text = JSON.stringify(last?.content ?? "");
  let closed = false;
  res.on("close", () => {
    if (!res.writableEnded) {
      closed = true;
      fake.aborted++;
    }
  });
  res.writeHead(200, { "content-type": "text/event-stream" });
  const words = async (list: string[], gap: number) => {
    for (const w of list) {
      if (closed) return;
      res.write(chunk({ role: "assistant", content: w }));
      await sleep(gap);
    }
  };
  const call = (name: string, args: object) => {
    res.write(
      chunk({
        tool_calls: [
          { index: 0, id: `call_${fake.requests}`, type: "function", function: { name, arguments: "" } },
        ],
      }),
    );
    res.write(chunk({ tool_calls: [{ index: 0, function: { arguments: JSON.stringify(args) } }] }));
    res.write(chunk({}, "tool_calls"));
  };
  if (last?.role === "tool" && text.includes("approved the plan")) {
    call("write", { path: "plan.txt", content: "planned\n" });
  } else if (last?.role === "tool") {
    await words(["Wrote ", "hello.txt."], 20);
    res.write(chunk({}, "stop"));
  } else if (text.includes("make a plan")) {
    call("plan_exit", { plan: "## Plan\n\n1. Write plan.txt" });
  } else if (text.includes("write it")) {
    res.write(chunk({ role: "assistant", content: "Writing the file." }));
    call("write", { path: "hello.txt", content: "hi\n" });
  } else if (text.includes("go slow")) {
    await words(
      Array.from({ length: 200 }, (_, i) => `word${i}${i % 4 === 3 ? "\n\n" : " "}`),
      150,
    );
    if (closed) return;
    res.write(chunk({}, "stop"));
  } else {
    await words(["Hello ", "from ", "the ", "fake ", "model."], 30);
    res.write(chunk({}, "stop"));
  }
  res.write(
    `data: ${JSON.stringify({ id: "c", choices: [], usage: { prompt_tokens: 10, completion_tokens: 5 } })}\n\n`,
  );
  res.end("data: [DONE]\n\n");
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

const home = mkdtempSync(join(tmpdir(), "agency-e2e-home-"));
const ws = mkdtempSync(join(tmpdir(), "agency-e2e-ws-"));
mkdirSync(join(home, "config"), { recursive: true });
const configFile = join(home, "config", "config.jsonc");
writeFileSync(
  configFile,
  `// e2e user config\n${JSON.stringify(
    {
      model: "fake-openai/m",
      provider: {
        "fake-openai": {
          baseUrl: `${origin}/v1`,
          apiKey: "k",
          models: { m: { contextWindow: 32000, maxOutputTokens: 1000 } },
        },
      },
    },
    null,
    2,
  )}\n`,
);
// The catalog the daemon reads instead of models.dev: a gateway with more models than the menu shows unsearched.
mkdirSync(join(home, "data", "cache"), { recursive: true });
writeFileSync(
  join(home, "data", "cache", "models-dev-catalog.json"),
  JSON.stringify({
    version: 2,
    savedAt: new Date().toISOString(),
    models: Array.from({ length: 14 }, (_, i) => ({
      id: `vendor/model-${i}`,
      family: "openrouter",
      name: `Gateway Model ${i}`,
      providerName: "OpenRouter",
      contextWindow: 128000,
      maxOutputTokens: 8000,
      capabilities: { tools: true, vision: false, thinking: false },
      releaseDate: `2026-01-${String(i + 1).padStart(2, "0")}`,
    })),
  }),
);
writeFileSync(join(ws, "note.txt"), "a note\n");
const git = (...args: string[]) => execFileSync("git", args, { cwd: ws, stdio: "pipe" });
git("init", "-q", "-b", "main");
git("-c", "user.name=e2e", "-c", "user.email=e2e@example.invalid", "add", "note.txt");
git("-c", "user.name=e2e", "-c", "user.email=e2e@example.invalid", "commit", "-q", "-m", "init");

const port = 9300 + Math.floor(Math.random() * 500);
// No real provider keys: the app sees only the fake model and a gateway key that is never sent.
const env: Record<string, string | undefined> = Object.fromEntries(
  Object.entries(process.env).filter(([k]) => !/_API_KEY$|_TOKEN$/i.test(k)),
);
Object.assign(env, {
  AGENCY_OPENROUTER_API_KEY: "e2e-not-a-key",
  AGENCY_DISABLE_MODELS_FETCH: "1",
  AGENCY_HOME: home,
  AGENCY_AGENTS_HOME: home,
  AGENCY_UPDATE_URL: `${origin}/no-update.json`,
  WEBVIEW2_USER_DATA_FOLDER: join(home, "webview"),
  WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}`,
});
let proc: ChildProcess | null = spawn(app, [ws], { env, stdio: "ignore" });

function daemonPids(): number[] {
  const dir = join(home, "data", "instances");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => Number(JSON.parse(readFileSync(join(dir, f), "utf8")).pid))
    .filter((pid) => pid > 0);
}

function cleanup(): void {
  if (proc?.pid) spawnSyncQuiet("taskkill", ["/T", "/F", "/PID", String(proc.pid)]);
  for (const pid of daemonPids()) spawnSyncQuiet("taskkill", ["/T", "/F", "/PID", String(pid)]);
  // A daemon that started in the last step may have no instance file yet; its command line names this home.
  spawnSyncQuiet("powershell", [
    "-NoProfile",
    "-Command",
    `Get-CimInstance Win32_Process -Filter "Name = 'agency.exe'" | Where-Object { $_.CommandLine -like '*${home}*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }`,
  ]);
  proc = null;
  server.close();
}
function spawnSyncQuiet(cmd: string, args: string[]): void {
  try {
    execFileSync(cmd, args, { stdio: "ignore" });
  } catch {}
}

interface Cdp {
  send(method: string, params?: object): Promise<Record<string, unknown>>;
}
async function attach(): Promise<Cdp> {
  for (let i = 0; i < 300; i++) {
    try {
      const list = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()) as {
        type: string;
        webSocketDebuggerUrl: string;
      }[];
      const page = list.find((t) => t.type === "page");
      if (page) {
        const sock = new WebSocket(page.webSocketDebuggerUrl);
        await new Promise((r, j) => {
          sock.onopen = r;
          sock.onerror = j;
        });
        let next = 1;
        const waiting = new Map<number, (m: Record<string, unknown>) => void>();
        sock.onmessage = (m) => {
          const msg = JSON.parse(String(m.data));
          waiting.get(msg.id)?.(msg);
          waiting.delete(msg.id);
        };
        return {
          send: (method, params = {}) =>
            new Promise((r) => {
              const id = next++;
              waiting.set(id, r);
              sock.send(JSON.stringify({ id, method, params }));
            }),
        };
      }
    } catch {}
    await sleep(100);
  }
  throw new Error("no WebView2 page target");
}

let cdp: Cdp;
try {
  cdp = await attach();
} catch (error) {
  cleanup();
  throw error;
}
async function ev<T = unknown>(expression: string): Promise<T> {
  const msg = (await cdp.send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  })) as {
    result?: { result?: { value?: T }; exceptionDetails?: unknown };
  };
  if (msg.result?.exceptionDetails)
    throw new Error(`page threw: ${JSON.stringify(msg.result.exceptionDetails)}`);
  return msg.result?.result?.value as T;
}
async function until(label: string, expression: string, ms = 20_000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await ev<boolean>(`!!(${expression})`).catch(() => false)) return;
    await sleep(100);
  }
  const text = await ev<string>(
    `"toasts: " + JSON.stringify(window.__toasts ?? []) + "\\n" + document.body.innerText`,
  ).catch(() => "<no page>");
  throw new Error(`timed out: ${label}\n--- page text ---\n${text.slice(0, 3000)}`);
}
/** Connected: neither the reconnect banner nor the stopped-daemon card shows. */
const UP = `!document.body.innerText.includes("Connecting to the daemon") && !document.querySelector(".down")`;
const bodyHas = (text: string) => `document.body.innerText.includes(${JSON.stringify(text)})`;
const button = (text: string, scope = "document") =>
  `[...${scope}.querySelectorAll("button")].find((b) => b.textContent.trim() === ${JSON.stringify(text)} && !b.disabled)`;
async function click(expression: string, label: string): Promise<void> {
  await until(`${label} is clickable`, expression);
  await ev(`(${expression}).click()`);
}
async function say(text: string): Promise<void> {
  await until("composer", `document.getElementById("composer")`);
  await ev(`window.__toasts ??= (new MutationObserver(() => {
    const t = document.querySelector(".toast")?.textContent;
    if (t && window.__toasts.at(-1) !== t) window.__toasts.push(t);
  }).observe(document.body, { subtree: true, childList: true, characterData: true }), [])`);
  await ev(`document.getElementById("composer").focus()`);
  await cdp.send("Input.insertText", { text });
  await click(`document.querySelector('button[aria-label="Send"]:not([disabled])')`, "Send");
}

const results: [string, boolean, string?][] = [];
async function step(name: string, run: () => Promise<void>): Promise<void> {
  const t0 = Date.now();
  try {
    await run();
    results.push([name, true]);
    console.log(`PASS ${name} (${Date.now() - t0} ms)`);
  } catch (error) {
    results.push([name, false, String(error)]);
    console.log(`FAIL ${name}: ${error}`);
    const shot = (await cdp.send("Page.captureScreenshot", { format: "png" })) as {
      result?: { data?: string };
    };
    if (shot.result?.data) {
      const file = join(home, `fail-${results.length}.png`);
      writeFileSync(file, Buffer.from(shot.result.data, "base64"));
      console.log(`screenshot: ${file}`);
    }
    throw error;
  }
}

async function fill(selector: string, text: string): Promise<void> {
  const q = `document.querySelector(${JSON.stringify(selector)})`;
  await until(selector, q);
  await ev(`(() => { const el = ${q}; el.focus(); el.select?.(); })()`);
  await cdp.send("Input.insertText", { text });
}

async function waitFile(file: string, re: RegExp, label: string, ms = 15_000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (re.test(readFileSync(file, "utf8"))) return;
    await sleep(100);
  }
  throw new Error(`timed out: ${label}\n${readFileSync(file, "utf8")}`);
}

/** Drives the Windows folder picker through UI Automation: types the path and presses Select Folder. */
function pickFolder(path: string): string {
  // The folder box and Select Folder show as plain panes to UI Automation: drive them by window handle.
  const byId = (id: string) => `(New-Object $P ($A::AutomationIdProperty, '${id}'))`;
  return [
    "Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes",
    'Add-Type -TypeDefinition \'using System; using System.Runtime.InteropServices; public static class W { [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr SendMessage(IntPtr h, int m, IntPtr w, string l); [DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr h, int m, IntPtr w, IntPtr l); }\'',
    "$A = [System.Windows.Automation.AutomationElement]; $T = [System.Windows.Automation.TreeScope]; $P = [System.Windows.Automation.PropertyCondition]",
    // UI Automation lists an owned dialog under its owner window, not under the desktop.
    "$app = $A::RootElement.FindFirst($T::Children, (New-Object $P ($A::ClassNameProperty, 'Tauri Window')))",
    "$win = $null; for ($i = 0; $i -lt 100 -and -not $win; $i++) { $win = $app.FindFirst($T::Children, (New-Object $P ($A::NameProperty, 'Open a project folder'))); if (-not $win) { Start-Sleep -Milliseconds 200 } }",
    "if (-not $win) { throw 'no folder dialog' }",
    `$edit = $null; for ($i = 0; $i -lt 50 -and -not $edit; $i++) { $edit = $win.FindFirst($T::Descendants, ${byId("1152")}); if (-not $edit) { Start-Sleep -Milliseconds 200 } }`,
    "if (-not $edit) { throw 'no folder box' }",
    `[void][W]::SendMessage([IntPtr]$edit.Current.NativeWindowHandle, 0x000C, [IntPtr]::Zero, '${path.replace(/'/g, "''")}')`,
    "$btn = $win.FindFirst($T::Descendants, (New-Object $P ($A::NameProperty, 'Select Folder')))",
    "if (-not $btn) { throw 'no Select Folder button' }",
    "[void][W]::SendMessage([IntPtr]$btn.Current.NativeWindowHandle, 0x00F5, [IntPtr]::Zero, [IntPtr]::Zero)",
  ].join("; ");
}

const wsName = ws.split(/[\\/]/).pop() ?? "";
const extraDirs: string[] = [];
try {
  await step("app opens the folder passed on the command line", async () => {
    await until("sidebar", `document.querySelector('nav[aria-label="Sessions"]')`, 60_000);
    await until("project in the sidebar", bodyHas(wsName), 30_000);
    const saved = JSON.parse(readFileSync(join(home, "desktop", "projects.json"), "utf8")) as {
      path: string;
    }[];
    if (!saved.some((p) => resolve(p.path) === resolve(ws)))
      throw new Error("projects.json lacks the workspace");
  });

  await step("new session streams a reply", async () => {
    await until("daemon up", UP, 60_000);
    await say("say hello");
    await until("streamed reply", bodyHas("Hello from the fake model."));
    await until("session row", `document.querySelector("button.side-row.sess")`);
  });

  await step("tool call asks, Allow once runs it", async () => {
    await say("write it");
    await until("approval card", `document.querySelector('section[aria-label="Approval request"]')`);
    await click(
      button("Allow once", `document.querySelector('section[aria-label="Approval request"]')`),
      "Allow once",
    );
    await until("tool result reply", bodyHas("Wrote hello.txt."));
    const written = readFileSync(join(ws, "hello.txt"), "utf8");
    if (written !== "hi\n") throw new Error(`hello.txt holds ${JSON.stringify(written)}`);
  });

  await step("the view follows a reply until you scroll up, then stop ends the turn", async () => {
    const before = fake.aborted;
    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width: 1100,
      height: 520,
      deviceScaleFactor: 1,
      mobile: false,
    });
    try {
      await say("go slow");
      await until("streaming", bodyHas("word3"));
      const tx = `document.querySelector(".tx-scroll")`;
      const atEnd = `${tx}.scrollHeight - ${tx}.scrollTop - ${tx}.clientHeight < 48`;
      await until(
        "the reply overflows and the view follows it",
        `${tx}.scrollHeight > ${tx}.clientHeight + 200 && ${atEnd}`,
      );
      await ev(`${tx}.scrollTop = 0`);
      const jump = `document.querySelector('button[aria-label="Jump to the latest message"]')`;
      await until("jump button", jump);
      await sleep(800);
      if (!(await ev<boolean>(`${tx}.scrollTop < 5`)))
        throw new Error("the view moved after the reader scrolled up");
      await click(jump, "Jump to the latest message");
      await until("back at the end", atEnd);
    } finally {
      await cdp.send("Emulation.clearDeviceMetricsOverride");
    }
    await click(`document.querySelector('button[aria-label="Stop turn"]')`, "Stop");
    await until("send is back", `document.querySelector('button[aria-label="Send"]')`, 10_000);
    await until(
      "no spinner on the row",
      `!document.querySelector('button.side-row.sess [aria-label="Running"]')`,
      10_000,
    );
    const end = Date.now() + 5000;
    while (fake.aborted === before && Date.now() < end) await sleep(100);
    if (fake.aborted === before) throw new Error("the model request was not cancelled");
  });

  await step("history survives a reload", async () => {
    await ev("location.reload()");
    await sleep(500);
    await until(
      "reloaded transcript",
      `${bodyHas("Hello from the fake model.")} && ${bodyHas("Wrote hello.txt.")}`,
      30_000,
    );
    await until(
      "the tool group reads as one summary line",
      `[...document.querySelectorAll(".work-head")].some((b) => b.textContent.includes("Wrote hello.txt"))`,
    );
    await until(
      "a turn footer with latency, speed and tokens",
      `[...document.querySelectorAll(".turn-foot")].some((f) => /latency/.test(f.textContent) && /tok\\/s/.test(f.textContent) && /tokens out/.test(f.textContent))`,
    );
  });

  await step("right-click a session: rename it, and the name survives a reload", async () => {
    await ev(`(() => {
      const row = document.querySelector("button.side-row.sess");
      const r = row.getBoundingClientRect();
      row.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: r.left + 20, clientY: r.top + 10 }));
    })()`);
    await click(
      `[...document.querySelectorAll('[role="menu"][aria-label^="Actions for"] [role="menuitem"]')].find((b) => b.textContent === "Rename")`,
      "Rename",
    );
    await until("rename field", `document.activeElement?.classList.contains("side-rename")`);
    await cdp.send("Input.insertText", { text: "Renamed by e2e" });
    for (const type of ["keyDown", "keyUp"])
      await cdp.send("Input.dispatchKeyEvent", {
        type,
        key: "Enter",
        code: "Enter",
        windowsVirtualKeyCode: 13,
      });
    await until(
      "renamed row",
      `document.querySelector("button.side-row.sess")?.textContent.includes("Renamed by e2e")`,
    );
    await ev("location.reload()");
    await sleep(500);
    await until("name after reload", bodyHas("Renamed by e2e"), 30_000);
  });

  await step("daemon kill shows the banner, then reconnects", async () => {
    await ev(`(() => {
      window.__seen = [];
      new MutationObserver(() => {
        const b = document.querySelector(".banner");
        if (b) window.__seen.push(b.textContent);
      }).observe(document.body, { subtree: true, childList: true, characterData: true });
    })()`);
    const pids = daemonPids();
    if (pids.length === 0) throw new Error("no daemon instance file");
    for (const pid of pids) process.kill(pid);
    await until(
      "offline banner",
      `window.__seen.some((t) => t.includes("Connecting to the daemon"))`,
      20_000,
    );
    await until("reconnected", UP, 60_000);
    await say("say hello again");
    await until(
      "reply after reconnect",
      `document.body.innerText.split("Hello from the fake model.").length > 2`,
    );
  });

  await step("a settings change persists to the user config", async () => {
    await click(button("Settings"), "Settings");
    await until("settings dialog", `document.querySelector('input[placeholder="Search settings"]')`);
    const before = readFileSync(configFile, "utf8");
    await ev(`document.querySelector('input[placeholder="Search settings"]').focus()`);
    await cdp.send("Input.insertText", { text: "Compaction" });
    await until("compaction limit field", `document.querySelector('input[aria-label="Compaction limit"]')`);
    await ev(`document.querySelector('input[aria-label="Compaction limit"]').select()`);
    await cdp.send("Input.insertText", { text: "50000" });
    await ev(`document.querySelector('input[aria-label="Compaction limit"]').blur()`);
    const end = Date.now() + 10_000;
    let after = before;
    while (Date.now() < end && !/"compactionLimit":\s*50000/.test(after)) {
      await sleep(100);
      after = readFileSync(configFile, "utf8");
    }
    if (!/"compactionLimit":\s*50000/.test(after))
      throw new Error(`config file lacks compactionLimit 50000:\n${after}`);
    if (!after.startsWith("// e2e user config")) throw new Error("the config comment was lost");
    await ev("location.reload()");
    await sleep(500);
    await until("daemon up after reload", UP, 60_000);
    await click(button("Settings"), "Settings");
    await until("settings dialog", `document.querySelector('input[placeholder="Search settings"]')`);
    await ev(`document.querySelector('input[placeholder="Search settings"]').focus()`);
    await cdp.send("Input.insertText", { text: "Compaction" });
    await until(
      "the daemon reads back 50000",
      `document.querySelector('input[aria-label="Compaction limit"]')?.value === "50000"`,
      30_000,
    );
    await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape" });
    await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape" });
    await until("settings closed", `!document.querySelector('input[placeholder="Search settings"]')`);
  });

  await step("skills: trust the folder, create one, switch it off and on, use it", async () => {
    await click(button("Skills"), "Skills");
    const note = bodyHas("Skills in this folder load once you trust it.");
    await until("trust note", note, 30_000);
    await click(button("Trust folder"), "Trust folder");
    await until("trusted", `!(${note}) && ${UP}`, 60_000);
    await click(button("New skill"), "New skill");
    await fill('input[placeholder="release-notes"]', "e2e-skill");
    await fill('input[placeholder="When Agency should use this skill"]', "Checks the e2e flow");
    await fill('textarea[placeholder="The steps Agency follows when the skill runs"]', "Say ok.");
    await click(button("Create skill"), "Create skill");
    await until(
      "skill page",
      `[...document.querySelectorAll("h2")].some((h) => h.textContent === "e2e-skill")`,
    );
    const file = readFileSync(join(ws, ".agency", "skills", "e2e-skill", "SKILL.md"), "utf8");
    if (!file.includes("name: e2e-skill") || !file.includes("Say ok."))
      throw new Error(`SKILL.md holds:\n${file}`);
    await click(button("Turn off"), "Turn off");
    await waitFile(configFile, /"disabled":\s*\[\s*"e2e-skill"\s*\]/, "skills.disabled lists e2e-skill");
    await click(button("Turn on"), "Turn on");
    await waitFile(configFile, /"disabled":\s*\[\s*\]/, "skills.disabled is empty again");
    await click(button("Use in session"), "Use in session");
    await until(
      "composer holds the command",
      `document.getElementById("composer")?.value.startsWith("/e2e-skill ")`,
    );
  });

  await step("workflows: a two-step run survives a daemon restart", async () => {
    await click(button("Workflows"), "Workflows");
    await click(button("New workflow"), "New workflow");
    await fill('input[placeholder="Fix failing checks"]', "E2E flow");
    await fill('textarea[aria-label="Instruction for step 1"]', "say hello");
    await click(button("Add step"), "Add step");
    await fill('textarea[aria-label="Instruction for step 2"]', "say hello twice");
    await click(button("Save"), "Save");
    const before = fake.requests;
    await until("Run now", button("Run now"));
    // A settings change restarts the daemon once it is idle: a step can start in that gap.
    for (const pid of daemonPids()) {
      try {
        process.kill(pid);
      } catch {}
    }
    await ev(`(${button("Run now")}).click()`);
    await until("run passed", `!!document.querySelector('[aria-label="Passed"]')`, 60_000);
    const saved = readdirSync(join(ws, ".agency", "workflows")).filter((f) => f.endsWith(".json"));
    if (saved.length !== 1) throw new Error(`workflow files: ${saved.join(", ")}`);
    if (fake.requests - before !== 2)
      throw new Error(`the run made ${fake.requests - before} model calls, not 2`);
  });

  await step("an environment's variable and setup script reach the next session", async () => {
    await click(button("Settings"), "Settings");
    await click(button("Environments"), "Environments section");
    await click(button("Add environment"), "Add environment");
    await fill('input[aria-label="Name"]', "E2E env");
    await fill('textarea[aria-label="Environment variables"]', "AGENCY_E2E=from-env");
    // The script runs in the shell of the model's commands, Git Bash or PowerShell: bun reads the same in both.
    await fill(
      'textarea[aria-label="Setup script"]',
      `bun -e "require('fs').writeFileSync('setup-ran.txt', process.env.AGENCY_E2E)"`,
    );
    await click(button("Save", `document.querySelector('fieldset[aria-label="New environment"]')`), "Save");
    const before = daemonPids();
    await click(`document.querySelector('button[aria-label="Environment of this project"]')`, "Environment");
    await click(
      `[...document.querySelectorAll('[role="menuitemradio"]')].find((b) => b.textContent.includes("E2E env"))`,
      "E2E env",
    );
    const end = Date.now() + 30_000;
    while (Date.now() < end && !daemonPids().some((pid) => !before.includes(pid))) await sleep(200);
    if (!daemonPids().some((pid) => !before.includes(pid))) throw new Error("the daemon did not restart");
    await click(`document.querySelector('button[aria-label="Close settings"]')`, "Close settings");
    await until("settings closed", `!document.querySelector('input[placeholder="Search settings"]')`);
    await until("daemon up with the environment", UP, 60_000);
    await click(button("New session"), "New session");
    await say("say hello");
    const marker = join(ws, "setup-ran.txt");
    const stop = Date.now() + 30_000;
    while (Date.now() < stop && !existsSync(marker)) await sleep(200);
    if (!existsSync(marker) || !readFileSync(marker, "utf8").includes("from-env")) {
      const failed = await ev<string>(
        `document.querySelector('section[aria-label="Turn failed"]')?.innerText ?? ""`,
      );
      throw new Error(
        `setup-ran.txt: ${existsSync(marker) ? readFileSync(marker, "utf8") : "missing"} ${failed}`,
      );
    }
  });

  await step("plan mode: the model presents a plan, approving it lets the edit run", async () => {
    await click(button("New session"), "New session");
    const mode = (label: string) =>
      click(
        `[...document.querySelectorAll('[role="menuitemradio"]')].find((b) => b.textContent.includes(${JSON.stringify(label)}))`,
        label,
      );
    await click(`document.querySelector('button[aria-label^="Permission mode:"]')`, "Permission mode");
    await mode("Plan");
    await say("make a plan");
    const card = `document.querySelector('section[aria-label="Plan approval"]')`;
    await until("plan card", `${card}?.textContent.includes("Write plan.txt")`, 30_000);
    if (existsSync(join(ws, "plan.txt"))) throw new Error("plan.txt exists before the approval");
    await click(button("Approve plan", card), "Approve plan");
    await until(
      "mode is Accept edits",
      `document.querySelector('button[aria-label="Permission mode: Accept edits"]')`,
    );
    await until("reply after the edit", bodyHas("Wrote hello.txt."), 30_000);
    if (readFileSync(join(ws, "plan.txt"), "utf8") !== "planned\n")
      throw new Error("plan.txt was not written");
    await click(`document.querySelector('button[aria-label^="Permission mode:"]')`, "Permission mode");
    await mode("Manual");
  });

  await step("Runs in: New worktree opens a worktree project and the session works in it", async () => {
    await click(button("New session"), "New session");
    await click(button("Local"), "Runs in");
    await click(
      `[...document.querySelectorAll('[role="menuitemradio"]')].find((b) => b.textContent.includes("New worktree"))`,
      "New worktree",
    );
    const parent = join(ws, ".agency", "worktrees");
    await until(
      "worktree project in the sidebar",
      `${bodyHas(`${wsName}-`)} && ${button("Worktree")}`,
      30_000,
    );
    const name = readdirSync(parent).find((f) => f.startsWith(`${wsName}-`)) ?? "";
    const wt = join(parent, name);
    await until("on the worktree branch", bodyHas(`agency/${name}`));
    await until("daemon up in the worktree", UP, 60_000);
    await say("write it");
    await click(
      button("Allow once", `document.querySelector('section[aria-label="Approval request"]')`),
      "Allow once",
    );
    await until("tool result reply", bodyHas("Wrote hello.txt."));
    await until(
      "composer says Worktree",
      `document.querySelector('[title="Runs in"]')?.textContent.trim() === "Worktree"`,
    );
    if (readFileSync(join(wt, "hello.txt"), "utf8") !== "hi\n")
      throw new Error("hello.txt is not in the worktree");
    const branch = execFileSync("git", ["branch", "--show-current"], { cwd: wt }).toString().trim();
    if (branch !== `agency/${name}`) throw new Error(`the worktree is on ${branch}`);
    if (git("status", "--porcelain").toString().includes("worktrees"))
      throw new Error("the main checkout lists the worktree");
  });

  await step("model picker lists a connected gateway's models and finds one by search", async () => {
    await click(button("New session"), "New session");
    const picker = `document.querySelector('[role="dialog"][aria-label="Choose a model"]')`;
    await click(`document.querySelector('button[aria-label^="Model:"]')`, "Model");
    await until(
      "the fake model and 14 gateway models",
      `${picker}?.querySelectorAll('[role="option"]').length === 15`,
      30_000,
    );
    await ev(`${picker}.querySelector('input[type="search"]').focus()`);
    await cdp.send("Input.insertText", { text: "model-13" });
    await until("one match", `${picker}.querySelectorAll('[role="option"]').length === 1`);
    for (const type of ["keyDown", "keyUp"])
      await cdp.send("Input.dispatchKeyEvent", {
        type,
        key: "Enter",
        code: "Enter",
        windowsVirtualKeyCode: 13,
      });
    await until("Enter picks it", `document.querySelector('button[aria-label="Model: Gateway Model 13"]')`);
  });

  await step("Open folder picks a second project in the system dialog", async () => {
    const second = mkdtempSync(join(tmpdir(), "agency-e2e-ws2-"));
    extraDirs.push(second);
    await click(button("Open folder"), "Open folder");
    execFileSync("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", pickFolder(second)], {
      stdio: "inherit",
    });
    const name = second.split(/[\\/]/).pop() ?? "";
    await until("second project in the sidebar", bodyHas(name), 30_000);
    const saved = JSON.parse(readFileSync(join(home, "desktop", "projects.json"), "utf8")) as {
      path: string;
    }[];
    if (!saved.some((p) => resolve(p.path) === resolve(second)))
      throw new Error("projects.json lacks the folder");
  });
} catch {
  // The failed step already printed its reason.
} finally {
  cleanup();
}

const failed = results.filter((r) => !r[1]);
console.log(`\n${results.length - failed.length} passed, ${failed.length} failed`);
if (failed.length === 0 && !process.argv.includes("--keep")) {
  for (const dir of [home, ws, ...extraDirs]) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
    } catch (error) {
      console.log(`could not remove ${dir}: ${error}`);
    }
  }
} else {
  console.log(`kept ${home} and ${ws}`);
}
process.exit(failed.length === 0 ? 0 : 1);
