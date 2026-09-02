import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FULL_CAPABILITIES, SandboxBoundary } from "@agency/guard";
import { AgencyError, ErrorCode } from "@agency/schema";
import { type BashState, createBashTool } from "../../src/builtins/bash.ts";
import type { ToolDeps } from "../../src/contract.ts";
import { ProcessManager } from "../../src/process-manager.ts";
import { resolveShell } from "../../src/shell.ts";

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

  test("a nonzero exit code is reported in the output, not as isError", async () => {
    const { tool } = setup();
    const result = await tool.handler({ command: `node -e "process.exit(7)"` }, { signal });
    expect(result.content).toContain("exit code: 7");
    expect(result.isError).toBeFalsy();
  }, 30_000);

  test("a zero exit code is not reported (only nonzero is noteworthy)", async () => {
    const { tool } = setup();
    const result = await tool.handler({ command: "echo ok" }, { signal });
    expect(result.content).not.toContain("exit code");
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
