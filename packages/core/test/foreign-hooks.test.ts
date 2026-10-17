import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { type CommandHooks, runCommandHooks } from "../src/plugins/command-hooks.ts";
import { foreignHookPaths, loadForeignHooks } from "../src/plugins/foreign-hooks.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function folder(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "agency-foreign-hooks-"));
  dirs.push(dir);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  return dir;
}

/** A hook command that runs `body` with the test's own runtime; `input` is the event it got on stdin. */
const script = (dir: string, name: string, body: string): string => {
  const file = join(dir, `${name}.js`);
  writeFileSync(
    file,
    `let s = ""; process.stdin.on("data", (d) => (s += d)); process.stdin.on("end", () => { const input = JSON.parse(s); ${body} });`,
  );
  return `"${process.execPath}" "${file}"`;
};

test("a workspace gives the hooks of Claude Code, Codex, Cursor and Gemini CLI, with their events mapped", () => {
  const ws = folder({});
  const cmd = "echo hi";
  for (const [path, value] of Object.entries({
    ".claude/settings.json": {
      permissions: {},
      hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: cmd }] }] },
    },
    ".claude/settings.local.json": { hooks: { Stop: [{ hooks: [{ type: "command", command: cmd }] }] } },
    ".codex/hooks.json": {
      hooks: {
        SessionStart: [{ hooks: [{ type: "command", command: cmd }] }],
        Interrupt: [{ hooks: [{ type: "command", command: cmd }] }],
      },
    },
    ".cursor/hooks.json": {
      version: 1,
      hooks: {
        beforeShellExecution: [{ command: cmd, matcher: "curl|wget", failClosed: true }],
        afterFileEdit: [{ command: cmd }],
        afterAgentThought: [{ command: cmd }],
      },
    },
    ".gemini/settings.json": {
      hooks: {
        BeforeTool: [
          { matcher: "run_shell_command", hooks: [{ type: "command", command: cmd, timeout: 5000 }] },
        ],
      },
    },
  })) {
    mkdirSync(dirname(join(ws, path)), { recursive: true });
    writeFileSync(join(ws, path), JSON.stringify(value));
  }
  const warnings: string[] = [];
  const hooks = loadForeignHooks(ws, (w) => warnings.push(w));
  expect(Object.keys(hooks).sort()).toEqual(["PostToolUse", "PreToolUse", "SessionStart", "Stop"]);
  expect(hooks.PreToolUse).toEqual([
    { matcher: "Bash", hooks: [{ type: "command", command: cmd }] },
    {
      matcher: "bash",
      hooks: [
        {
          type: "command",
          command: cmd,
          cursor: { event: "beforeShellExecution", matcher: "curl|wget", failClosed: true },
        },
      ],
    },
    { matcher: "run_shell_command", hooks: [{ type: "command", command: cmd, timeout: 5 }] },
  ]);
  expect(hooks.PostToolUse?.[0]?.matcher).toBe("write|edit");
  expect(warnings.join("\n")).toContain("Interrupt");
  expect(warnings.join("\n")).toContain("afterAgentThought");
  expect(foreignHookPaths(ws)).toContain(join(ws, ".cursor", "hooks.json"));
});

test("the matcher of another agent names the tool here: Shell, run_shell_command and WebFetch match", async () => {
  const ws = folder({});
  const block = script(ws, "block", 'console.error("no"); process.exit(2);');
  for (const [matcher, tool] of [
    ["Shell", "bash"],
    ["run_shell_command", "bash"],
    ["WebFetch", "fetch"],
    ["Edit|Write", "write"],
  ] as const) {
    const hooks: CommandHooks = { PreToolUse: [{ matcher, hooks: [{ type: "command", command: block }] }] };
    expect(await runCommandHooks(hooks, "PreToolUse", { tool_name: tool }, { cwd: ws })).toEqual({
      block: "no",
    });
  }
  const hooks: CommandHooks = {
    PreToolUse: [{ hooks: [{ type: "command", command: block, if: "WebFetch(*)" }] }],
  };
  expect(
    await runCommandHooks(hooks, "PreToolUse", { tool_name: "fetch", tool_input: {} }, { cwd: ws }),
  ).toEqual({ block: "no" });
});

test("a Cursor hook gets its own input, and its answer blocks, adds context or asks the agent to go on", async () => {
  const ws = folder({});
  const cursor = (event: string, body: string, extra: Record<string, unknown> = {}): CommandHooks => ({
    PreToolUse: [
      { hooks: [{ type: "command", command: script(ws, event, body), cursor: { event, ...extra } }] },
    ],
  });
  const deny = cursor(
    "beforeShellExecution",
    'console.log(JSON.stringify({ permission: "deny", agent_message: "no " + input.command + " in " + input.workspace_roots[0].length }));',
    { matcher: "curl" },
  );
  const shell = (command: string) => ({ tool_name: "bash", tool_input: { command } });
  expect(await runCommandHooks(deny, "PreToolUse", shell("curl x"), { cwd: ws })).toEqual({
    block: `no curl x in ${ws.length}`,
  });
  // The matcher of a shell hook of Cursor tests the command.
  expect(await runCommandHooks(deny, "PreToolUse", shell("ls"), { cwd: ws })).toEqual({});

  const failed = cursor("beforeShellExecution", "process.exit(1);", { failClosed: true });
  expect((await runCommandHooks(failed, "PreToolUse", shell("ls"), { cwd: ws })).block).toBeDefined();

  const followup = cursor("stop", 'console.log(JSON.stringify({ followup_message: "run the tests" }));');
  expect(await runCommandHooks(followup, "PreToolUse", {}, { cwd: ws })).toEqual({ block: "run the tests" });

  const context = cursor(
    "sessionStart",
    'console.log(JSON.stringify({ additional_context: "branch dev" }));',
  );
  expect(await runCommandHooks(context, "PreToolUse", {}, { cwd: ws })).toEqual({ context: "branch dev" });
});

test("a Gemini CLI hook that answers decision deny blocks", async () => {
  const ws = folder({});
  const hooks: CommandHooks = {
    PreToolUse: [
      {
        hooks: [
          {
            type: "command",
            command: script(ws, "gem", 'console.log(JSON.stringify({ decision: "deny", reason: "no" }));'),
          },
        ],
      },
    ],
  };
  expect(await runCommandHooks(hooks, "PreToolUse", { tool_name: "bash" }, { cwd: ws })).toEqual({
    block: "no",
  });
});
