import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FULL_CAPABILITIES, SandboxBoundary } from "@agency/guard";
import { AgencyError, ErrorCode } from "@agency/schema";
import { type BashState, createBashTool } from "../../src/builtins/bash.ts";
import type { ToolDeps } from "../../src/contract.ts";
import { ProcessManager } from "../../src/process-manager.ts";
import { resolveConfiguredShell, resolveShell } from "../../src/shell.ts";

const dirs: string[] = [];
const managers: ProcessManager[] = [];
afterEach(async () => {
  // Kill spawned processes and give the OS a moment to release any handles
  // (e.g. the process's own cwd) before removing the directories they used.
  for (const m of managers.splice(0)) m.killAll();
  await new Promise((r) => setTimeout(r, 100));
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
});

function setup(commandPolicy?: ConstructorParameters<typeof SandboxBoundary>[1]) {
  const root = mkdtempSync(join(tmpdir(), "agency-bash-test-"));
  dirs.push(root);
  const capabilities = { ...FULL_CAPABILITIES, pathScopes: [root] };
  const deps: ToolDeps = {
    identity: { type: "user" },
    capabilities,
    sandbox: new SandboxBoundary(root, commandPolicy),
  };
  const state: BashState = { cwd: root };
  const manager = new ProcessManager();
  managers.push(manager);
  const shell = resolveShell(process.platform);
  const tool = createBashTool(deps, shell, state, manager);
  return { tool, state, root };
}

const signal = new AbortController().signal;
const pwdCommand = process.platform === "win32" ? "(Get-Location).Path" : "pwd";

describe("createBashTool", () => {
  test("runs a command and returns its output", async () => {
    const { tool } = setup();
    const result = await tool.handler({ command: "echo hello-from-bash-tool" }, { signal });
    expect(result.content).toContain("hello-from-bash-tool");
  }, 30_000);

  test("the provider keys of the harness are not in the environment of a command, and other variables are", async () => {
    const { tool } = setup();
    process.env.AGENCY_ENVTEST_API_KEY = "harness-key-71f3";
    process.env.ENVTEST_PLAIN = "plain-value-52c1";
    const read = (name: string): string =>
      process.platform === "win32" ? `Write-Output "[$env:${name}]"` : `echo "[$${name}]"`;
    try {
      const key = await tool.handler({ command: read("AGENCY_ENVTEST_API_KEY") }, { signal });
      expect(key.content).toContain("[]");
      const plain = await tool.handler({ command: read("ENVTEST_PLAIN") }, { signal });
      expect(plain.content).toContain("[plain-value-52c1]");
    } finally {
      delete process.env.AGENCY_ENVTEST_API_KEY;
      delete process.env.ENVTEST_PLAIN;
    }
  }, 30_000);

  test("the variables of the call context (shell.env of plugins) reach a command and a background command", async () => {
    const { tool } = setup();
    const env = { ENVTEST_PLUGIN: "from-plugin-8d2e" };
    const read =
      process.platform === "win32" ? `Write-Output "[$env:ENVTEST_PLUGIN]"` : `echo "[$ENVTEST_PLUGIN]"`;
    expect((await tool.handler({ command: read }, { signal, env })).content).toContain("[from-plugin-8d2e]");
    const manager = managers.at(-1) as ProcessManager;
    await tool.handler({ command: read, background: true }, { signal, env });
    const [info] = manager.list();
    const logs = () => manager.getLogs(info?.id ?? "") ?? "";
    for (let waited = 0; waited < 20_000 && !logs().includes("[from-plugin"); waited += 100) {
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(logs()).toContain("[from-plugin-8d2e]");
  }, 30_000);

  // Two sequential real shell spawns; PowerShell's cold start in this
  // sandbox is slow and variable enough that the 5s default is too tight.
  test("working directory persists across calls within a session", async () => {
    const { tool, state, root } = setup();
    mkdirSync(join(root, "subdir"));

    await tool.handler({ command: "cd subdir" }, { signal });
    expect(state.cwd.toLowerCase()).toContain("subdir");

    const result = await tool.handler({ command: pwdCommand }, { signal });
    expect(result.content.toLowerCase()).toContain("subdir");
  }, 15_000);

  test("the exit and cwd marker lines are stripped from returned output", async () => {
    const { tool } = setup();
    const result = await tool.handler({ command: "echo just-the-output" }, { signal });
    expect(result.content).not.toContain("__AGENCY_CWD__");
    expect(result.content).not.toContain("__AGENCY_EXIT__");
  }, 30_000);

  test("truncates output past the stated byte limit", async () => {
    const { tool } = setup();
    const result = await tool.handler({ command: `node -e "console.log('x'.repeat(40000))"` }, { signal });
    expect(result.content).toContain("[truncated");
    expect(result.content.length).toBeLessThan(31_000);
  }, 30_000);

  test("truncation never splits a multi-byte character", async () => {
    const { tool } = setup();
    // 29998 x's + newline lands the 30000-byte cut mid-emoji (4 bytes each),
    // so a surrogate-splitting cut would surface as U+FFFD replacement chars.
    const result = await tool.handler(
      { command: `node -e "console.log('x'.repeat(29998) + '\\uD83C\\uDF89'.repeat(10))"` },
      { signal },
    );
    expect(result.content).toContain("[truncated");
    expect(result.content).not.toContain("\uFFFD");
    expect(result.content.length).toBeLessThan(31_000);
  }, 30_000);

  test("a nonzero exit code is reported in the output and sets isError", async () => {
    const { tool } = setup();
    const result = await tool.handler({ command: `node -e "process.exit(7)"` }, { signal });
    expect(result.content).toContain("exit code: 7");
    expect(result.isError).toBe(true);
  }, 30_000);

  test("a command that ends the shell itself still reports its exit code", async () => {
    const { tool } = setup();
    const result = await tool.handler({ command: "exit 3" }, { signal });
    expect(result.content).toContain("exit code: 3");
    expect(result.isError).toBe(true);
  }, 30_000);

  test("a timeout kill is reported and sets isError with partial output retained", async () => {
    const { tool } = setup();
    const command =
      process.platform === "win32"
        ? `Write-Output 'partial-output-before-timeout'; Start-Sleep -Seconds 30`
        : `echo partial-output-before-timeout; sleep 30`;
    const result = await tool.handler({ command, timeout: 8_000 }, { signal });
    expect(result.content).toContain("partial-output-before-timeout");
    expect(result.content).toContain("[timeout");
    expect(result.isError).toBe(true);
  }, 60_000);

  test("a zero exit code is not reported (only nonzero is noteworthy)", async () => {
    const { tool } = setup();
    const result = await tool.handler({ command: "echo ok" }, { signal });
    expect(result.content).not.toContain("exit code");
    expect(result.isError).toBeFalsy();
  }, 30_000);

  test("a deny-listed command is rejected with PERMISSION_DENIED before running", async () => {
    const { tool } = setup({ deny: [/rm -rf/] });
    const err = await tool.handler({ command: "rm -rf /" }, { signal }).catch((e) => e);
    expect(err).toBeInstanceOf(AgencyError);
    expect((err as AgencyError).code).toBe(ErrorCode.PERMISSION_DENIED);
  });

  test("background: true returns immediately without waiting for exit", async () => {
    const { tool } = setup();
    const start = Date.now();
    const result = await tool.handler(
      { command: `node -e "setTimeout(()=>{}, 5000)"`, background: true },
      { signal },
    );
    expect(Date.now() - start).toBeLessThan(2_000);
    expect(result.content).toContain("started background process");
  });

  test("a background command runs in the sandbox of the backend, and a backend that cannot hold one refuses it", async () => {
    const root = mkdtempSync(join(tmpdir(), "agency-bash-test-"));
    dirs.push(root);
    const wrapped: string[][] = [];
    const osLike = Object.assign(new SandboxBoundary(root), {
      exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
      wrap: (argv: string[]) => {
        wrapped.push(argv);
        return [process.execPath, "-e", "setTimeout(() => {}, 100)"];
      },
    });
    const manager = new ProcessManager();
    managers.push(manager);
    const deps = (sandbox: SandboxBoundary): ToolDeps => ({
      identity: { type: "user" },
      capabilities: { ...FULL_CAPABILITIES, pathScopes: [root] },
      sandbox,
    });
    const shell = resolveShell(process.platform);
    const tool = createBashTool(deps(osLike), shell, { cwd: root }, manager);
    await tool.handler({ command: "echo outside", background: true }, { signal });
    expect(wrapped).toHaveLength(1);
    expect(wrapped[0]?.at(-1)).toContain("echo outside");
    expect(manager.list()[0]?.command).toContain(process.execPath);

    const containerLike = Object.assign(new SandboxBoundary(root), {
      exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
    });
    const refused = createBashTool(deps(containerLike), shell, { cwd: root }, manager);
    const result = await refused.handler({ command: "echo outside", background: true }, { signal });
    expect(result.isError).toBe(true);
    expect(manager.list()).toHaveLength(1);
  });

  test("aborting the signal kills the running process", async () => {
    const { tool } = setup();
    const controller = new AbortController();

    const resultPromise = tool.handler(
      { command: `node -e "setInterval(()=>{}, 1000)"` },
      { signal: controller.signal },
    );
    await new Promise((r) => setTimeout(r, 200));
    controller.abort();

    // The handler should settle (process killed) rather than hang forever.
    await resultPromise;
    // macOS CI can be slow to deliver the kill signal to the child.
  }, 60_000);

  test("aborting stops the command's own child process, not only the shell", async () => {
    const { tool, root } = setup();
    const controller = new AbortController();
    const beat = join(root, "beat").split(String.fromCharCode(92)).join("/");
    const command = `node -e "setInterval(()=>require('fs').writeFileSync('${beat}', String(Date.now())), 50)"`;

    const resultPromise = tool.handler({ command }, { signal: controller.signal });
    const deadline = Date.now() + 20_000;
    while (!existsSync(beat)) {
      if (Date.now() > deadline) throw new Error("the child never started");
      await new Promise((r) => setTimeout(r, 50));
    }
    controller.abort();
    await resultPromise;

    // A child that still runs writes a new time each 50 ms.
    await new Promise((r) => setTimeout(r, 500));
    const after = readFileSync(beat, "utf8");
    await new Promise((r) => setTimeout(r, 500));
    expect(readFileSync(beat, "utf8")).toBe(after);
  }, 60_000);

  test("aborting preserves partial output and labels the result cancelled", async () => {
    const { tool, root } = setup();
    const controller = new AbortController();
    const markerPath = join(root, "abort-flushed.marker");
    const command =
      process.platform === "win32"
        ? `Write-Output 'partial-output-before-abort'; Set-Content -LiteralPath '${markerPath.replace(/\\/g, "/")}' -Value done; Start-Sleep -Seconds 30`
        : `echo partial-output-before-abort; touch '${markerPath}'; sleep 30`;

    const resultPromise = tool.handler({ command }, { signal: controller.signal });
    // Deterministic abort point: the marker file is created only after the
    // output line was written, so partial output is already in the pipe.
    const deadline = Date.now() + 20_000;
    while (!existsSync(markerPath)) {
      if (Date.now() > deadline) throw new Error("marker file never appeared");
      await new Promise((r) => setTimeout(r, 50));
    }
    controller.abort();
    const result = await resultPromise;

    expect(result.content).toContain("partial-output-before-abort");
    expect(result.content).toContain("[cancelled");
    expect(result.content).not.toContain("exit code: 0");
    expect(result.isError).toBe(true);
  }, 60_000);

  test("aborting tears down the process tree via ProcessManager.killTree", async () => {
    const root = mkdtempSync(join(tmpdir(), "agency-bash-test-"));
    dirs.push(root);
    const deps: ToolDeps = {
      identity: { type: "user" },
      capabilities: { ...FULL_CAPABILITIES, pathScopes: [root] },
      sandbox: new SandboxBoundary(root),
    };
    const state: BashState = { cwd: root };
    const killedPids: number[] = [];
    const manager = { killTree: (pid: number) => killedPids.push(pid) } as unknown as ProcessManager;
    const tool = createBashTool(deps, resolveShell(process.platform), state, manager);
    const controller = new AbortController();

    const command = process.platform === "win32" ? "Start-Sleep -Seconds 30" : "sleep 30";
    const resultPromise = tool.handler({ command }, { signal: controller.signal });
    await new Promise((r) => setTimeout(r, 300));
    controller.abort();
    const result = await resultPromise;

    expect(killedPids.length).toBe(1);
    expect(killedPids[0]).toBeGreaterThan(0);
    expect(result.content).toContain("[cancelled");
  }, 60_000);

  test("repeated calls leave no abort listeners on the shared per-turn signal", async () => {
    const { tool } = setup();
    const controller = new AbortController();
    const inner = controller.signal;
    let added = 0;
    let removed = 0;
    const counting = new Proxy(inner, {
      get(target, prop, _receiver) {
        if (prop === "addEventListener") {
          return (...args: Parameters<AbortSignal["addEventListener"]>) => {
            added += 1;
            return target.addEventListener(...args);
          };
        }
        if (prop === "removeEventListener") {
          return (...args: Parameters<AbortSignal["removeEventListener"]>) => {
            removed += 1;
            return target.removeEventListener(...args);
          };
        }
        // target as receiver: Bun brand-checks the `aborted` getter, so it
        // must be invoked on the real AbortSignal, not on the proxy.
        return Reflect.get(target, prop, target);
      },
    }) as AbortSignal;

    await tool.handler({ command: "echo one" }, { signal: counting });
    await tool.handler({ command: "echo two" }, { signal: counting });

    expect(added).toBeGreaterThan(0);
    expect(added).toBe(removed);
  }, 30_000);
});

describe("createBashTool cwd containment (A5: bash calls resolvePath)", () => {
  const signal = new AbortController().signal;

  test("a cd that leaves the workspace is refused and the previous cwd kept", async () => {
    const { tool, state, root } = setup();
    const result = await tool.handler({ command: "cd .." }, { signal });

    expect(state.cwd).toBe(root);
    expect(result.content).toContain("resolves outside the workspace");
  }, 30_000);

  test("a cd to a symlinked directory pointing outside is refused too", async () => {
    const { tool, state, root } = setup();
    const parent = join(root, "..");
    const linkName = process.platform === "win32" ? "escape-link" : "escape-link";
    const linkPath = join(root, linkName);
    symlinkSync(parent, linkPath, process.platform === "win32" ? "junction" : "dir");

    const result = await tool.handler({ command: `cd ${linkName}` }, { signal });
    expect(state.cwd).toBe(root);
    expect(result.content).toContain("resolves outside the workspace");
  }, 30_000);
});

describe.skipIf(process.platform !== "win32" || Bun.which("bash") === null)(
  "createBashTool in Git Bash",
  () => {
    test("a directory change persists across calls, with no notice that it left the workspace", async () => {
      // Live: `pwd` gave the MSYS form (/tmp/...), no call could change the directory, and each result had the notice.
      const root = mkdtempSync(join(tmpdir(), "agency-bash-test-"));
      dirs.push(root);
      mkdirSync(join(root, "sub"));
      const deps: ToolDeps = {
        identity: { type: "user" },
        capabilities: { ...FULL_CAPABILITIES, pathScopes: [root] },
        sandbox: new SandboxBoundary(root),
      };
      const manager = new ProcessManager();
      managers.push(manager);
      const tool = createBashTool(deps, resolveShell("win32", "gitbash"), { cwd: root }, manager);

      const moved = await tool.handler({ command: "cd sub" }, { signal });
      expect(moved.content).not.toContain("cwd kept");
      const where = await tool.handler({ command: 'basename "$(pwd)"' }, { signal });
      expect(where.content.trim()).toBe("sub");
    }, 60_000);

    test("aborting stops the command's own child process, through the launcher that Git for Windows installs", async () => {
      const root = mkdtempSync(join(tmpdir(), "agency-bash-test-"));
      dirs.push(root);
      const deps: ToolDeps = {
        identity: { type: "user" },
        capabilities: { ...FULL_CAPABILITIES, pathScopes: [root] },
        sandbox: new SandboxBoundary(root),
      };
      const manager = new ProcessManager();
      managers.push(manager);
      // The shell that a real run uses: bin/bash.exe starts usr/bin/bash.exe, one more level in the tree.
      const tool = createBashTool(deps, resolveConfiguredShell("win32", "gitbash"), { cwd: root }, manager);
      const controller = new AbortController();
      const beat = join(root, "beat").split(String.fromCharCode(92)).join("/");
      const command = `node -e "setInterval(()=>require('fs').writeFileSync('${beat}', String(Date.now())), 50)"`;

      const resultPromise = tool.handler({ command }, { signal: controller.signal });
      const deadline = Date.now() + 20_000;
      while (!existsSync(beat)) {
        if (Date.now() > deadline) throw new Error("the child never started");
        await new Promise((r) => setTimeout(r, 50));
      }
      controller.abort();
      await resultPromise;

      await new Promise((r) => setTimeout(r, 500));
      const after = readFileSync(beat, "utf8");
      await new Promise((r) => setTimeout(r, 500));
      expect(readFileSync(beat, "utf8")).toBe(after);
    }, 60_000);

    test("aborting stops a program of Git Bash itself, which the tree of Windows does not show as a child", async () => {
      // Live: after a cancel, `sleep.exe` of a command was alive and its parent was gone. `taskkill /T` follows parents.
      const root = mkdtempSync(join(tmpdir(), "agency-bash-test-"));
      dirs.push(root);
      const deps: ToolDeps = {
        identity: { type: "user" },
        capabilities: { ...FULL_CAPABILITIES, pathScopes: [root] },
        sandbox: new SandboxBoundary(root),
      };
      const manager = new ProcessManager();
      managers.push(manager);
      const tool = createBashTool(deps, resolveConfiguredShell("win32", "gitbash"), { cwd: root }, manager);
      const seconds = String(7000 + Math.floor(Math.random() * 2000));
      const alive = (): boolean => {
        const query = `Get-CimInstance Win32_Process -Filter "Name='sleep.exe'" | ForEach-Object { $_.CommandLine }`;
        const out = Bun.spawnSync(["powershell", "-NoProfile", "-Command", query]).stdout.toString();
        return out.includes(` ${seconds}`);
      };
      const controller = new AbortController();
      const resultPromise = tool.handler(
        { command: `sleep ${seconds} && echo finished` },
        { signal: controller.signal },
      );
      const deadline = Date.now() + 20_000;
      while (!alive()) {
        if (Date.now() > deadline) throw new Error("the child never started");
        await new Promise((r) => setTimeout(r, 200));
      }
      controller.abort();
      await resultPromise;
      await new Promise((r) => setTimeout(r, 1000));
      const left = alive();
      // The test must not leave its own process on the machine when it fails.
      if (left)
        Bun.spawnSync([
          "powershell",
          "-NoProfile",
          "-Command",
          `Get-CimInstance Win32_Process -Filter "Name='sleep.exe'" | Where-Object { $_.CommandLine -like '* ${seconds}' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }`,
        ]);
      expect(left).toBe(false);
    }, 60_000);
  },
);
