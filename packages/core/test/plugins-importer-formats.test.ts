import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { parseAgentFile } from "../src/agents/files.ts";
import { importClaudePlugin } from "../src/plugins/importer.ts";

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
  expect(JSON.parse(read(ws, "hooks", "cur-hooks.json")).hooks.PostToolUse).toEqual([
    {
      matcher: "write|edit",
      hooks: [{ type: "command", command: `node ${root}/fmt.js`, cursor: { event: "afterFileEdit" } }],
    },
  ]);
});
