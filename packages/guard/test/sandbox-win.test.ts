import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureSandboxAvailable } from "../src/sandbox-docker.ts";
import {
  buildScriptSandboxArgv,
  OsSandboxBackend,
  scriptSandboxAvailable,
  scriptSandboxEnv,
} from "../src/sandbox-os.ts";
import { quoteWindowsArg, windowsSandboxSid, windowsSandboxTemp } from "../src/sandbox-win.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function tmp(name: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), `agency-winsb-${name}-`)));
  dirs.push(dir);
  return dir;
}

describe("Windows sandbox: pure parts", () => {
  test("one SID for each workspace, the same for each spelling of its path", () => {
    const sid = windowsSandboxSid("C:\\Users\\u\\ws");
    expect(sid).toMatch(/^S-1-5-21-\d+-\d+-\d+-1001$/);
    expect(windowsSandboxSid("c:/users/U/ws")).toBe(sid);
    expect(windowsSandboxSid("C:\\Users\\u\\ws2")).not.toBe(sid);
  });

  test("an argument is quoted as the C runtime reads it", () => {
    expect(quoteWindowsArg("plain")).toBe("plain");
    expect(quoteWindowsArg("")).toBe('""');
    expect(quoteWindowsArg("a b")).toBe('"a b"');
    expect(quoteWindowsArg('say "hi"')).toBe('"say \\"hi\\""');
    expect(quoteWindowsArg("C:\\dir with space\\")).toBe('"C:\\dir with space\\\\"');
    expect(quoteWindowsArg('a\\"b c')).toBe('"a\\\\\\"b c"');
  });

  test("Git Bash, or no network permission, stops the daemon with the reason", async () => {
    const bash = new OsSandboxBackend("C:/ws", {}, undefined, {
      platform: "win32",
      allowNetwork: true,
      windowsShell: "gitbash",
    });
    await expect(ensureSandboxAvailable(bash)).rejects.toThrow("Git Bash (MSYS)");
    const offline = new OsSandboxBackend("C:/ws", {}, undefined, { platform: "win32" });
    await expect(ensureSandboxAvailable(offline)).rejects.toThrow("sandbox.allowNetwork");
  });
});

// These run the real token, job and access rules: Windows only.
describe.skipIf(process.platform !== "win32")("Windows sandbox: commands under the restricted token", () => {
  async function backend(): Promise<{ sandbox: OsSandboxBackend; ws: string; outside: string }> {
    const ws = tmp("ws");
    const outside = tmp("outside");
    mkdirSync(join(ws, ".git", "hooks"), { recursive: true });
    writeFileSync(join(ws, ".git", "config"), "[core]\n");
    mkdirSync(join(ws, ".agency", "hooks"), { recursive: true });
    mkdirSync(join(ws, ".agency", "worktrees"), { recursive: true });
    const sandbox = new OsSandboxBackend(ws, {}, undefined, { allowNetwork: true });
    dirs.push(windowsSandboxTemp(windowsSandboxSid(ws)));
    expect(await sandbox.isAvailable()).toBe(true);
    return { sandbox, ws, outside };
  }
  const cmd = (line: string): string[] => ["cmd.exe", "/d", "/c", line];

  test("a command writes in the workspace and in its temporary folder, and not outside or in .git/hooks", async () => {
    const { sandbox, ws, outside } = await backend();
    const inside = await sandbox.exec(cmd("echo in> in.txt && type in.txt"), { cwd: ws });
    expect(inside.exitCode).toBe(0);
    expect(inside.stdout.trim()).toBe("in");

    const out = await sandbox.exec(cmd(`echo out> "${join(outside, "out.txt")}"`), { cwd: ws });
    expect(out.exitCode).not.toBe(0);
    expect(existsSync(join(outside, "out.txt"))).toBe(false);

    const hook = await sandbox.exec(cmd("echo x> .git\\hooks\\pre-commit"), { cwd: ws });
    expect(hook.exitCode).not.toBe(0);
    expect(existsSync(join(ws, ".git", "hooks", "pre-commit"))).toBe(false);

    const temp = await sandbox.exec(cmd("echo t> %TEMP%\\t.txt && type %TEMP%\\t.txt"), { cwd: ws });
    expect(temp.stdout.trim()).toBe("t");
  }, 60_000);

  test("a command cannot write .git/config or add to .agency; the worktrees of a team stay writable", async () => {
    const { sandbox, ws } = await backend();
    const run = async (line: string): Promise<number> =>
      (await sandbox.exec(cmd(line), { cwd: ws })).exitCode;
    expect(await run("echo x>> .git\\config")).not.toBe(0);
    expect(readFileSync(join(ws, ".git", "config"), "utf8")).toBe("[core]\n");
    expect(await run("echo {}> .agency\\hooks\\evil.json")).not.toBe(0);
    expect(await run("ren .agency\\hooks old")).not.toBe(0);
    expect(await run("mkdir .agency\\mcp")).not.toBe(0);
    expect(await run("echo x> .agency\\new.txt")).not.toBe(0);
    expect(existsSync(join(ws, ".agency", "mcp"))).toBe(false);
    expect(existsSync(join(ws, ".agency", "new.txt"))).toBe(false);
    expect(await run("echo ok> .agency\\worktrees\\w.txt")).toBe(0);
  }, 60_000);

  test("git works in the sandbox: a commit writes the objects, the index and the refs", async () => {
    const ws = tmp("git");
    expect(Bun.spawnSync(["git", "init", "-q", ws]).exitCode).toBe(0);
    const sandbox = new OsSandboxBackend(ws, {}, undefined, { allowNetwork: true });
    dirs.push(windowsSandboxTemp(windowsSandboxSid(ws)));
    expect(await sandbox.isAvailable()).toBe(true);
    const line =
      "echo a> a.txt && git add a.txt && git -c user.name=t -c user.email=t@t commit -q -m one && git log --format=%s";
    const result = await sandbox.exec(cmd(line), { cwd: ws });
    expect(result.stdout.trim()).toBe("one");
    expect(result.exitCode).toBe(0);
  }, 60_000);

  test("the command gets its arguments as given, and its exit code comes back", async () => {
    const { sandbox, ws } = await backend();
    writeFileSync(
      join(ws, "argv.js"),
      "console.log(JSON.stringify(process.argv.slice(2))); process.exit(7);",
    );
    const args = ["a b", 'q"uote', "back\\slash\\", "", 'tail\\\\"x', "--", "plain"];
    const result = await sandbox.exec([process.execPath, "argv.js", ...args], { cwd: ws });
    expect(result.exitCode).toBe(7);
    expect(JSON.parse(result.stdout)).toEqual(args);
  }, 60_000);

  test("a timeout ends the command and the processes it started", async () => {
    const { sandbox, ws } = await backend();
    const beat = join(ws, "beat.txt");
    const child = `setInterval(() => require("fs").appendFileSync(${JSON.stringify(beat)}, "x"), 50)`;
    const parent = `Bun.spawn([process.execPath, "-e", ${JSON.stringify(child)}], { stdio: ["ignore", "ignore", "ignore"] }); setInterval(() => {}, 1000)`;
    await expect(
      sandbox.exec([process.execPath, "-e", parent], { cwd: ws, timeoutMs: 2000 }),
    ).rejects.toThrow("timed out");
    expect(existsSync(beat)).toBe(true);
    const size = statSync(beat).size;
    await Bun.sleep(600);
    expect(readFileSync(beat).length).toBe(size);
  }, 60_000);
});

describe.skipIf(process.platform !== "win32")(
  "Windows script sandbox: an AppContainer with no capability",
  () => {
    test("a script talks on stdin and stdout, and has no network, no user files and no write outside", async () => {
      expect(await scriptSandboxAvailable([process.execPath])).toBe(true);
      const secret = join(tmp("secret"), "secret.txt");
      writeFileSync(secret, "s3cret");
      const outside = join(tmp("outside"), "w.txt");
      const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("open") });
      const script = `(async () => {
      const fs = require("fs");
      const out = {};
      try { fs.readFileSync(${JSON.stringify(secret)}, "utf8"); out.read = "open"; } catch (e) { out.read = e.code; }
      try { fs.writeFileSync(${JSON.stringify(outside)}, "x"); out.write = "open"; } catch (e) { out.write = e.code; }
      try { await fetch("http://127.0.0.1:${server.port}/"); out.net = "open"; } catch { out.net = "blocked"; }
      let s = "";
      for await (const chunk of process.stdin) s += chunk;
      out.stdin = s.trim();
      console.log(JSON.stringify(out));
      process.exit(3);
    })();`;
      try {
        const argv = buildScriptSandboxArgv([process.execPath, "-e", script], [process.execPath]) ?? [];
        const child = Bun.spawn(argv, {
          stdin: "pipe",
          stdout: "pipe",
          stderr: "pipe",
          env: scriptSandboxEnv(),
        });
        child.stdin.write("from the loop");
        child.stdin.end();
        const [out, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
        expect(code).toBe(3);
        expect(JSON.parse(out)).toEqual({
          read: "EPERM",
          write: "EPERM",
          net: "blocked",
          stdin: "from the loop",
        });
        expect(existsSync(outside)).toBe(false);
      } finally {
        server.stop(true);
      }
    }, 60_000);
  },
);
