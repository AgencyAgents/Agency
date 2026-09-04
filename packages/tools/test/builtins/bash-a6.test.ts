import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FULL_CAPABILITIES, SandboxBoundary } from "@agency/guard";
import { type BashState, createBashTool } from "../../src/builtins/bash.ts";
import {
  createProcessKillTool,
  createProcessListTool,
  createProcessOutputTool,
} from "../../src/builtins/process.ts";
import { createQuestionTool } from "../../src/builtins/question.ts";
import type { ToolDeps } from "../../src/contract.ts";
import { ProcessManager } from "../../src/process-manager.ts";
import { resolveShell } from "../../src/shell.ts";

const dirs: string[] = [];
const managers: ProcessManager[] = [];
afterEach(async () => {
  for (const m of managers.splice(0)) m.killAll();
  await new Promise((r) => setTimeout(r, 100));
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
});

function setup() {
  const root = mkdtempSync(join(tmpdir(), "agency-bash-a6-"));
  dirs.push(root);
  const deps: ToolDeps = {
    identity: { type: "user" },
    capabilities: { ...FULL_CAPABILITIES, pathScopes: [root] },
    sandbox: new SandboxBoundary(root),
  };
  const state: BashState = { cwd: root };
  const manager = new ProcessManager();
  managers.push(manager);
  const tool = createBashTool(deps, resolveShell(process.platform), state, manager);
  return { tool, state, root, deps, manager };
}

const signal = new AbortController().signal;

describe("bash: timeout + spill + progress (A6)", () => {
  test("timeout kills a hanging command and labels the result", async () => {
    const { tool } = setup();
    const command = process.platform === "win32" ? "Start-Sleep -Seconds 30" : "sleep 30";
    const result = await tool.handler({ command, timeout: 1_000 }, { signal });

    expect(result.content).toContain("[timeout");
    expect(result.content).toContain("1000ms");
    expect(result.isError).toBeFalsy();
  }, 30_000);

  test("a fast command is unaffected by a generous timeout", async () => {
    const { tool } = setup();
    const result = await tool.handler({ command: "echo ok", timeout: 30_000 }, { signal });
    expect(result.content).toContain("ok");
    expect(result.content).not.toContain("[timeout");
  }, 30_000);

  test("overflow output is spilled to a temp file, not dropped", async () => {
    const { tool } = setup();
    const result = await tool.handler({ command: `node -e "console.log('y'.repeat(40000))"` }, { signal });

    expect(result.content).toContain("[truncated");
    expect(result.content).toContain("full output saved to");
    const match = /full output saved to (.+)$/m.exec(result.content);
    expect(match).not.toBeNull();
    const spillPath = match![1]!.trim().replace(/\]$/, "");
    expect(existsSync(spillPath)).toBe(true);
    expect(readFileSync(spillPath, "utf8").length).toBeGreaterThan(30_000);
    expect(result.content.length).toBeLessThan(31_000);
  }, 30_000);

  test("long-running commands emit progress through ctx.onProgress", async () => {
    const { tool } = setup();
    const messages: string[] = [];
    const command = process.platform === "win32" ? "Start-Sleep -Seconds 5" : "sleep 5";
    await tool.handler(
      { command },
      {
        signal,
        onProgress: (message: string) => messages.push(message),
      },
    );
    expect(messages.length).toBeGreaterThanOrEqual(1);
    expect(messages[0]).toContain("still running");
  }, 30_000);
});

describe("process_* builtins (A6)", () => {
  test("background → list → output → kill round-trip", async () => {
    const { deps, root } = setup();
    const started = new ProcessManager();
    managers.push(started);

    const shell = resolveShell(process.platform);
    const command = process.platform === "win32" ? "ping -n 30 127.0.0.1" : "sleep 30";
    const proc = started.spawn([shell.command, ...shell.buildArgs(command)], { cwd: root });

    const list = await createProcessListTool(started).handler({}, { signal });
    expect(list.content).toContain(proc.id);

    const output = createProcessOutputTool(started);
    let seen = "";
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      seen = (await output.handler({ id: proc.id }, { signal })).content;
      if (!seen.startsWith("no output yet")) break;
      await new Promise((r) => setTimeout(r, 200));
    }
    expect(seen).not.toContain("no output yet");

    const kill = await createProcessKillTool(deps, started).handler({ id: proc.id }, { signal });
    expect(kill.content).toContain("killed process");
  });

  test("unknown ids fail with a clear error", async () => {
    const { deps, manager } = setup();
    const out = await createProcessOutputTool(manager).handler({ id: "nope" }, { signal });
    expect(out.isError).toBe(true);
    expect(out.content).toContain("unknown process id: nope");

    const kill = await createProcessKillTool(deps, manager).handler({ id: "nope" }, { signal });
    expect(kill.isError).toBe(true);

    const list = await createProcessListTool(manager).handler({}, { signal });
    expect(list.content).toContain("no background processes");
  });
});

describe("question builtin (A6)", () => {
  test("returns the structured question with choices and next-message guidance", async () => {
    const tool = createQuestionTool();
    const result = await tool.handler(
      { question: "Which database?", choices: ["postgres", "sqlite"] },
      { signal },
    );
    expect(result.content).toContain('"type":"question"');
    expect(result.content).toContain('"question":"Which database?"');
    expect(result.content).toContain("1. postgres");
    expect(result.content).toContain("2. sqlite");
    expect(result.content).toContain("next message");
    expect(result.isError).toBeFalsy();
  });

  test("rejects an empty question", async () => {
    const tool = createQuestionTool();
    const result = await tool.handler({ question: "" }, { signal });
    expect(result.isError).toBe(true);
  });
});
