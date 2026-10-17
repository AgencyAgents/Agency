import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { OsSandboxBackend } from "../src/sandbox-os.ts";

// Real commands in the sandbox of the OS: Linux with bubblewrap, macOS with Seatbelt. Elsewhere they skip.
const posix = process.platform === "linux" || process.platform === "darwin";
const dirs: string[] = [];
const dir = (base: string): string => {
  const path = mkdtempSync(join(base, ".agency-osrun-"));
  dirs.push(path);
  return path;
};
afterAll(() => {
  for (const path of dirs) rmSync(path, { recursive: true, force: true });
});
const runs = posix && (await new OsSandboxBackend(dir(tmpdir())).isAvailable());
const site = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("site body") });
afterAll(() => site.stop(true));

describe.skipIf(!runs)("OS sandbox: real commands", () => {
  test("a command writes in the workspace, not outside it, and has no network", async () => {
    const ws = dir(tmpdir());
    // Not in the temp folder: the sandbox lets a command write there.
    const outside = dir(homedir());
    const sandbox = new OsSandboxBackend(ws);
    expect(await sandbox.isAvailable()).toBe(true);
    const inside = await sandbox.exec(["sh", "-c", "echo hi > in.txt"], { cwd: ws });
    expect(inside.exitCode).toBe(0);
    expect(existsSync(join(ws, "in.txt"))).toBe(true);
    const out = await sandbox.exec(["sh", "-c", `echo hi > '${join(outside, "out.txt")}'`], { cwd: ws });
    expect(out.exitCode).not.toBe(0);
    expect(existsSync(join(outside, "out.txt"))).toBe(false);
    const net = await sandbox.exec(["curl", "-s", "--max-time", "5", `http://127.0.0.1:${site.port}/`], {
      cwd: ws,
    });
    expect(net.stdout).not.toContain("site body");
  });

  test("a command cannot change a file whose hooks run outside the sandbox, nor make a new one", async () => {
    const ws = dir(tmpdir());
    const sandbox = new OsSandboxBackend(ws);
    expect(await sandbox.isAvailable()).toBe(true);
    await Bun.write(join(ws, ".claude", "settings.json"), "{}");
    const edit = await sandbox.exec(["sh", "-c", "echo x > .claude/settings.json"], { cwd: ws });
    expect(edit.exitCode).not.toBe(0);
    expect(await Bun.file(join(ws, ".claude", "settings.json")).text()).toBe("{}");
    const made = await sandbox.exec(["sh", "-c", "echo '{}' > .mcp.json; echo ok"], { cwd: ws });
    expect(made.stdout).toContain("ok");
    expect(existsSync(join(ws, ".mcp.json"))).toBe(false);
    if (process.platform === "linux") expect(made.stderr).toContain("agency sandbox: removed .mcp.json");
  });

  const domainsRun =
    runs && Bun.which("curl") !== null && (process.platform !== "linux" || Bun.which("socat") !== null);
  test.skipIf(!domainsRun)(
    "with allowedDomains a command reaches a listed host through the proxy, gets 403 for another, and nothing directly",
    async () => {
      const ws = dir(tmpdir());
      const sandbox = new OsSandboxBackend(ws, {}, undefined, { allowedDomains: ["localhost"] });
      expect(await sandbox.isAvailable()).toBe(true);
      const curl = (...args: string[]) =>
        sandbox.exec(["curl", "-s", "--max-time", "5", ...args], { cwd: ws });
      expect((await curl(`http://localhost:${site.port}/`)).stdout).toBe("site body");
      const other = await curl(`http://127.0.0.1:${site.port}/`);
      expect(other.stdout).toContain("127.0.0.1 is not in sandbox.allowedDomains");
      expect(other.stdout).not.toContain("site body");
      const direct = await curl("--noproxy", "*", `http://localhost:${site.port}/`);
      expect(direct.stdout).not.toContain("site body");
      expect(direct.exitCode).not.toBe(0);
    },
  );
});
