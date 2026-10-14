import { describe, expect, test } from "bun:test";
import { ensureSandboxAvailable } from "../src/sandbox-docker.ts";
import {
  buildBwrapArgs,
  buildScriptSandboxArgv,
  buildSeatbeltProfile,
  OsSandboxBackend,
} from "../src/sandbox-os.ts";

// No Linux or macOS machine ran these backends: the tests cover the arguments and the profile text only.
describe("OS sandbox arguments", () => {
  test("bubblewrap: read-only disk, writable workspace, read-only git hooks, no network by default", () => {
    const args = buildBwrapArgs("/home/u/ws", "/home/u/ws/src", false);
    const text = args.join(" ");
    expect(args[0]).toBe("bwrap");
    expect(text).toContain("--ro-bind / /");
    expect(text).toContain("--bind /home/u/ws /home/u/ws");
    expect(text).toContain("--ro-bind-try /home/u/ws/.git/hooks /home/u/ws/.git/hooks");
    // A later bind wins: the workspace bind must come after the read-only root, and the hooks after the workspace.
    expect(text.indexOf("--ro-bind / /")).toBeLessThan(text.indexOf("--bind /home/u/ws"));
    expect(text.indexOf("--bind /home/u/ws")).toBeLessThan(text.indexOf("--ro-bind-try"));
    expect(args).toContain("--unshare-net");
    expect(args).toContain("--die-with-parent");
    expect(args.slice(-3)).toEqual(["--chdir", "/home/u/ws/src", "--"]);
    expect(buildBwrapArgs("/home/u/ws", "/home/u/ws", true)).not.toContain("--unshare-net");
  });

  test("Seatbelt: writes denied outside the workspace, hooks denied after the allow, network denied by default", () => {
    const profile = buildSeatbeltProfile('/Users/u/my "ws"', false);
    const lines = profile.split("\n");
    expect(lines[0]).toBe("(version 1)");
    expect(profile).toContain('(subpath "/Users/u/my \\"ws\\"")');
    const allow = lines.findIndex((l) => l.startsWith("(allow file-write*"));
    expect(lines.indexOf("(deny file-write*)")).toBeLessThan(allow);
    expect(lines.findIndex((l) => l.includes(".git/hooks"))).toBeGreaterThan(allow);
    expect(lines).toContain("(deny network*)");
    expect(buildSeatbeltProfile("/Users/u/ws", true)).not.toContain("network");
  });

  test("bubblewrap: .git is pinned, its hooks and config and .agency are read-only, the data of the harness is hidden", () => {
    const ws = "/home/u/ws";
    const args = buildBwrapArgs(ws, ws, false, "bwrap", ["/home/u/.local/share/agency"]);
    const text = args.join(" ");
    const at = (part: string): number => {
      expect(text).toContain(part);
      return text.indexOf(part);
    };
    const hide = at("--tmpfs /home/u/.local/share/agency");
    const workspace = at(`--bind ${ws} ${ws}`);
    const pin = at(`--bind-try ${ws}/.git ${ws}/.git`);
    const config = at(`--ro-bind-try ${ws}/.git/config ${ws}/.git/config`);
    const agency = at(`--ro-bind-try ${ws}/.agency ${ws}/.agency`);
    const worktrees = at(`--bind-try ${ws}/.agency/worktrees ${ws}/.agency/worktrees`);
    // A later mount wins: each rule must come after the one it narrows.
    expect(hide).toBeLessThan(workspace);
    expect(workspace).toBeLessThan(pin);
    expect(pin).toBeLessThan(config);
    expect(agency).toBeLessThan(worktrees);
  });

  test("Seatbelt: the same rules, and no read of the data of the harness", () => {
    const lines = buildSeatbeltProfile("/Users/u/ws", false, "/private/tmp", [
      "/Users/u/.config/agency",
    ]).split("\n");
    expect(lines).toContain('(deny file-read* (subpath "/Users/u/.config/agency"))');
    const deny = lines.findIndex((l) => l.includes('(literal "/Users/u/ws/.git")'));
    expect(lines[deny]).toContain('(subpath "/Users/u/ws/.git/config")');
    expect(lines[deny]).toContain('(subpath "/Users/u/ws/.agency")');
    expect(deny).toBeGreaterThan(lines.findIndex((l) => l.startsWith("(allow file-write*")));
    expect(lines.indexOf('(allow file-write* (subpath "/Users/u/ws/.agency/worktrees"))')).toBeGreaterThan(
      deny,
    );
  });

  test("the backend wraps a command for its platform and keeps the command policy", () => {
    const linux = new OsSandboxBackend("/home/u/ws", { deny: [/rm -rf/] }, undefined, {
      platform: "linux",
    });
    expect(linux.wrap(["sh", "-c", "ls"]).slice(-4)).toEqual(["--", "sh", "-c", "ls"]);
    expect(() => linux.checkCommand("rm -rf /")).toThrow();
    const mac = new OsSandboxBackend("/Users/u/ws", {}, undefined, { platform: "darwin" });
    const wrapped = mac.wrap(["sh", "-c", "ls"]);
    expect(wrapped.slice(0, 2)).toEqual(["/usr/bin/sandbox-exec", "-p"]);
    expect(wrapped.slice(-3)).toEqual(["sh", "-c", "ls"]);
  });

  test("script sandbox: no network, nothing writable, and of the user's disk only the files of the runner", () => {
    const linux = buildScriptSandboxArgv(["/opt/agency", "__code"], ["/opt/agency"], "linux") ?? [];
    const text = linux.join(" ");
    expect(text).toContain("--unshare-all");
    expect(text).toContain("--ro-bind /opt/agency /opt/agency");
    // No bind of the root and no writable bind: the home folder is not in the view of the process.
    expect(text).not.toContain("--ro-bind / /");
    expect(linux).not.toContain("--bind");
    expect(linux.slice(-3)).toEqual(["--", "/opt/agency", "__code"]);

    const mac = buildScriptSandboxArgv(["/opt/agency", "__code"], ["/opt/agency"], "darwin") ?? [];
    const lines = (mac[2] ?? "").split("\n");
    expect(lines).toContain("(deny network*)");
    expect(lines).toContain("(deny file-write*)");
    const denyRead = lines.findIndex((l) => l.startsWith('(deny file-read* (subpath "/Users")'));
    expect(denyRead).toBeGreaterThan(-1);
    expect(lines.indexOf('(allow file-read* (subpath "/opt/agency"))')).toBeGreaterThan(denyRead);

    expect(buildScriptSandboxArgv(["x"], [], "win32")?.slice(-3)).toEqual(["appcontainer", "--", "x"]);
    expect(buildScriptSandboxArgv(["x"], [], "freebsd")).toBeUndefined();
  });

  test("on another platform the backend is not available, and the daemon start fails with the reason", async () => {
    const other = new OsSandboxBackend("/ws", {}, undefined, { platform: "freebsd" });
    expect(await other.isAvailable()).toBe(false);
    await expect(ensureSandboxAvailable(other)).rejects.toThrow("Linux, macOS and Windows only");
  });
});
