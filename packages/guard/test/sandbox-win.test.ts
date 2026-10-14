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
import { OsSandboxBackend } from "../src/sandbox-os.ts";
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
