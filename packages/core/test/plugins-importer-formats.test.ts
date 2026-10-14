import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { loadProjectLspServers } from "@agency/tools";
import { parseAgentFile } from "../src/agents/files.ts";
import { EventBus } from "../src/events.ts";
import { loadHookFiles, runCommandHooks } from "../src/plugins/command-hooks.ts";
import { importClaudePlugin } from "../src/plugins/importer.ts";
import { loadPlugins } from "../src/plugins/loader.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function folder(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "agency-import-formats-"));
  dirs.push(dir);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  return dir;
}

const skill = (name: string) => `---\nname: ${name}\ndescription: ${name} skill\n---\nbody\n`;
const read = (ws: string, ...parts: string[]) => readFileSync(join(ws, ".agency", ...parts), "utf8");

test("a Cursor plugin installs its rules, skills, agents, commands and MCP servers", () => {
  const src = folder({
    ".cursor-plugin/plugin.json": JSON.stringify({ name: "cur-kit", version: "1.0.0" }),
    "rules/always.mdc": "---\nalwaysApply: true\n---\nAlways rule",
    "rules/manual.mdc": "---\nalwaysApply: false\n---\nManual rule",
    "skills/cs/SKILL.md": skill("cs"),
    "agents/scout.md": "---\nname: scout\ndescription: Looks\nreadonly: true\n---\nYou look.",
    "commands/fix.txt": "Fix $ARGUMENTS",
    "mcp.json": JSON.stringify({
      mcpServers: { srv: { command: "node", args: ["${CURSOR_PLUGIN_ROOT}/srv.js"] } },
    }),
  });
  const ws = folder({});
  const report = importClaudePlugin(src, { sourceDir: src, workspaceRoot: ws });
  expect(report).toMatchObject({
    pluginName: "cur-kit",
    skillsInstalled: ["cs"],
    agentsInstalled: ["scout"],
    commandsInstalled: ["fix.md"],
    rulesInstalled: ["cur-kit-always.md"],
  });
  expect(read(ws, "rules", "cur-kit-always.md")).toBe("Always rule");
  expect(read(ws, "commands", "fix.md")).toBe("Fix $ARGUMENTS");
  expect(parseAgentFile(read(ws, "agents", "scout.md"), "scout.md")).toMatchObject({
    description: "Looks",
    tools: ["glob", "grep", "read"],
    systemPrompt: "You look.",
  });
  const root = join(ws, ".agency", "plugin-roots", "cur-kit").replaceAll("\\", "/");
  expect(JSON.parse(read(ws, "mcp", "cur-kit.json")).mcpServers.srv.args).toEqual([`${root}/srv.js`]);
});

test("a Gemini CLI extension installs its context file, TOML commands and MCP servers", () => {
  const src = folder({
    "gemini-extension.json": JSON.stringify({
      name: "gem-ext",
      version: "0.2.0",
      contextFileName: "CONTEXT.md",
      mcpServers: {
        g: { httpUrl: "https://g.test/mcp" },
        local: { command: "node", args: ["${extensionPath}${/}s.js"] },
      },
    }),
    "CONTEXT.md": "Gemini context",
    "commands/gcs/sync.toml": 'description = "Sync"\nprompt = "Sync {{args}}"\n',
  });
  const ws = folder({});
  const report = importClaudePlugin(src, { sourceDir: src, workspaceRoot: ws });
  expect(report).toMatchObject({
    pluginName: "gem-ext",
    commandsInstalled: ["gcs-sync.md"],
    rulesInstalled: ["gem-ext.md"],
  });
  expect(read(ws, "rules", "gem-ext.md")).toBe("Gemini context");
  expect(read(ws, "commands", "gcs-sync.md")).toBe("---\ndescription: Sync\n---\nSync $ARGUMENTS");
  const root = join(ws, ".agency", "plugin-roots", "gem-ext").replaceAll("\\", "/");
  expect(JSON.parse(read(ws, "mcp", "gem-ext.json")).mcpServers).toEqual({
    g: { url: "https://g.test/mcp" },
    local: { command: "node", args: [`${root}/s.js`] },
  });
});

test("a portable plugin.json takes its skill folder from the manifest, and its mcp.json", () => {
  const src = folder({
    "plugin.json": JSON.stringify({ name: "portable", skills: "./my-skills" }),
    "my-skills/ps/SKILL.md": skill("ps"),
    "skills/ignored/SKILL.md": skill("ignored"),
    "mcp.json": JSON.stringify({ mcpServers: { p: { type: "http", url: "https://p.test/mcp" } } }),
  });
  const ws = folder({});
  const report = importClaudePlugin(src, { sourceDir: src, workspaceRoot: ws });
  expect(report.skillsInstalled).toEqual(["ps"]);
  expect(Object.keys(report.mcpServers)).toEqual(["p"]);
});

test("a Pi package installs its skills, prompts and a module for its extensions", () => {
  const src = folder({
    "package.json": JSON.stringify({
      name: "@me/pi-tools",
      version: "1.2.0",
      keywords: ["pi-package"],
      pi: { extensions: ["./src/ext.ts"], skills: ["./skills"], prompts: ["./prompts/*.md"] },
    }),
    "skills/pis/SKILL.md": skill("pis"),
    "prompts/hello.md": "---\ndescription: Hello\n---\nSay hello to $1",
    "src/ext.ts": "export default function () {}",
  });
  const ws = folder({});
  const report = importClaudePlugin(src, { sourceDir: src, workspaceRoot: ws });
  expect(report).toMatchObject({
    pluginName: "pi-tools",
    pluginVersion: "1.2.0",
    skillsInstalled: ["pis"],
    commandsInstalled: ["hello.md"],
  });
  expect(report.partsSkipped).toEqual([]);
  expect(report.modulesInstalled).toEqual(["pi-tools.ts"]);
  expect(read(ws, "plugins", "pi-tools.ts")).toContain("export const piExtensions = [extension0];");
});

test("a Claude Code agent with keys that have no use here installs as an agent file of Agency", () => {
  const src = folder({
    ".claude-plugin/plugin.json": JSON.stringify({ name: "cc-kit" }),
    "agents/rev.md":
      "---\nname: rev\ndescription: Reviews\ntools: Read, Grep\nmaxTurns: 5\nmemory: project\n---\nYou review.",
  });
  const ws = folder({});
  const report = importClaudePlugin(src, { sourceDir: src, workspaceRoot: ws });
  expect(report.agentsInstalled).toEqual(["rev"]);
  expect(parseAgentFile(read(ws, "agents", "rev.md"), "rev.md")).toMatchObject({
    description: "Reviews",
    tools: ["grep", "read"],
  });
  expect(existsSync(join(ws, ".agency", "rules"))).toBe(false);
});

test("the hooks of a Cursor plugin install with their events mapped and the plugin root in place", () => {
  const src = folder({
    ".cursor-plugin/plugin.json": JSON.stringify({ name: "cur-hooks" }),
    "hooks/hooks.json": JSON.stringify({
      version: 1,
      hooks: { afterFileEdit: [{ command: "node ${CURSOR_PLUGIN_ROOT}/fmt.js" }] },
    }),
  });
  const ws = folder({});
  const report = importClaudePlugin(src, { sourceDir: src, workspaceRoot: ws });
  expect(report.hooksInstalled).toEqual(["PostToolUse"]);
  const root = join(ws, ".agency", "plugin-roots", "cur-hooks").replaceAll("\\", "/");
  expect(JSON.parse(read(ws, "hooks", "cur-hooks.json")).hooks.PostToolUse).toMatchObject([
    {
      matcher: "write|edit",
      hooks: [{ type: "command", command: `node ${root}/fmt.js`, cursor: { event: "afterFileEdit" } }],
    },
  ]);
});

test("a Claude Code plugin: bin on the PATH, the data folder and the root in hook variables, userConfig as variables, commands by name", async () => {
  const src = folder({
    ".claude-plugin/plugin.json": JSON.stringify({
      name: "cc-kit",
      userConfig: {
        api_url: { type: "string", title: "API URL" },
        api_token: { type: "string", sensitive: true },
      },
      commands: {
        about: { content: "Summarize the repo.", description: "Summarize" },
        deploy: { source: "./extra/deploy.md" },
        away: { source: "../outside.md" },
      },
    }),
    "bin/cc-tool": "#!/bin/sh\necho tool\n",
    "extra/deploy.md": "Deploy $ARGUMENTS",
    "hook.js":
      'console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: process.env.CLAUDE_PLUGIN_ROOT + "|" + process.env.CLAUDE_PLUGIN_DATA } }));',
    "hooks/hooks.json": JSON.stringify({
      hooks: {
        UserPromptSubmit: [
          {
            hooks: [
              { type: "command", command: 'node "${CLAUDE_PLUGIN_ROOT}/hook.js" "${CLAUDE_PLUGIN_DATA}"' },
            ],
          },
        ],
      },
    }),
    ".mcp.json": JSON.stringify({
      mcpServers: {
        api: {
          command: "node",
          args: ["${CLAUDE_PLUGIN_DATA}/s.js"],
          env: { TOKEN: "${user_config.api_token}" },
        },
      },
    }),
    "output-styles/terse.md": "---\nname: terse\n---\nShort.",
  });
  const ws = folder({});
  const report = importClaudePlugin(src, { sourceDir: src, workspaceRoot: ws });
  const root = join(ws, ".agency", "plugin-roots", "cc-kit");
  const data = join(ws, ".agency", "plugin-data", "cc-kit");
  expect(report.binDir).toBe(join(root, "bin"));
  expect(report.optionVariables).toEqual(["CLAUDE_PLUGIN_OPTION_API_URL", "CLAUDE_PLUGIN_OPTION_API_TOKEN"]);
  expect(report.commandsInstalled).toEqual(["about.md", "deploy.md"]);
  expect(read(ws, "commands", "about.md")).toBe("---\ndescription: Summarize\n---\nSummarize the repo.");
  expect(read(ws, "commands", "deploy.md")).toBe("Deploy $ARGUMENTS");
  expect(report.partsSkipped).toEqual(["output-styles: Agency has no output styles"]);
  expect(existsSync(data)).toBe(true);
  expect(report.mcpServers).toEqual({
    api: {
      command: "node",
      args: [`${data.replaceAll("\\", "/")}/s.js`],
      env: { TOKEN: "${CLAUDE_PLUGIN_OPTION_API_TOKEN}" },
    },
  });

  // The hook script reads both folders from its environment, as in Claude Code.
  const hooks = loadHookFiles(join(ws, ".agency", "hooks"));
  const outcome = await runCommandHooks(hooks, "UserPromptSubmit", { prompt: "hi" }, { cwd: ws });
  expect(outcome.context).toBe(`${root}|${data}`);

  // The bin folder is on the PATH of a shell command.
  const bus = new EventBus();
  await loadPlugins({ workspaceRoot: ws, bus, configDirOverride: folder({}) });
  const payload = { env: {} as Record<string, string> };
  await bus.emitAsync("shell.env", payload);
  const path = Object.entries(payload.env).find(([name]) => name.toUpperCase() === "PATH")?.[1] ?? "";
  expect(path.split(delimiter)[0]).toBe(join(root, "bin"));
});

test("a plugin with SKILL.md at its root and no skills folder is one skill", () => {
  const src = folder({
    ".claude-plugin/plugin.json": JSON.stringify({ name: "solo" }),
    "SKILL.md": "---\ndescription: The one skill\n---\nDo the thing.",
    "ref.md": "a reference",
  });
  const ws = folder({});
  const report = importClaudePlugin(src, { sourceDir: src, workspaceRoot: ws });
  expect(report.skillsInstalled).toEqual(["solo"]);
  expect(read(ws, "skills", "solo", "ref.md")).toBe("a reference");
});

test("the LSP servers of a Claude Code plugin install in the form here, and the daemon loader reads them", () => {
  const src = folder({
    ".claude-plugin/plugin.json": JSON.stringify({ name: "lsp-kit", lspServers: "./more-lsp.json" }),
    ".lsp.json": JSON.stringify({
      gopls: { command: "gopls", args: ["serve"], extensionToLanguage: { ".go": "go" } },
      ts: { command: "old-ts", extensionToLanguage: { ".ts": "typescript" } },
      broken: { args: ["x"] },
    }),
    "more-lsp.json": JSON.stringify({
      ts: {
        command: "${CLAUDE_PLUGIN_ROOT}/bin/ts-ls",
        args: ["--stdio"],
        extensionToLanguage: { ".ts": "typescript", ".tsx": "typescriptreact" },
      },
    }),
  });
  const ws = folder({});
  const report = importClaudePlugin(src, { sourceDir: src, workspaceRoot: ws });
  expect(report.lspServers).toEqual(["gopls", "ts"]);
  const root = join(ws, ".agency", "plugin-roots", "lsp-kit").replaceAll("\\", "/");
  expect(loadProjectLspServers(ws)).toEqual({
    gopls: { command: "gopls", args: ["serve"], extensions: [".go"], languageId: "go" },
    ts: {
      command: `${root}/bin/ts-ls`,
      args: ["--stdio"],
      extensions: [".ts", ".tsx"],
      languageId: "typescript",
    },
  });
  writeFileSync(join(ws, ".agency", "lsp", "bad.json"), "{");
  const warnings: string[] = [];
  expect(Object.keys(loadProjectLspServers(ws, (w) => warnings.push(w)))).toEqual(["gopls", "ts"]);
  expect(warnings.join("\n")).toContain("bad.json");
});
