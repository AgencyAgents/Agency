import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { loadProjectMcpServers, loadUserMcpServers } from "../../src/mcp/config.ts";
import { importMcpServers, MCP_IMPORT_SOURCES } from "../../src/mcp/foreign.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function folder(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "agency-mcp-foreign-"));
  dirs.push(dir);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  return dir;
}

const env = { TOKEN: "t-1", FIGMA_TOKEN: "f-1", ORG: "o-1" };

test("a workspace gives the MCP servers of the project files of VS Code, Cursor, Gemini, OpenCode, Codex and Pi", () => {
  const warnings: string[] = [];
  const ws = folder({
    ".vscode/mcp.json": `{
      // VS Code allows comments.
      "inputs": [{ "type": "promptString", "id": "key" }],
      "servers": {
        "vs": { "type": "stdio", "command": "node", "args": ["\${workspaceFolder}/s.js"] },
        "cur": { "command": "lower" },
        "asks": { "type": "http", "url": "https://a.test/mcp", "headers": { "X-Key": "\${input:key}" } },
      },
    }`,
    ".cursor/mcp.json": JSON.stringify({
      mcpServers: { cur: { url: "https://c.test/mcp", headers: { Authorization: "Bearer ${env:TOKEN}" } } },
    }),
    ".gemini/settings.json": JSON.stringify({
      theme: "x",
      mcpServers: { gem: { httpUrl: "https://g.test/mcp", timeout: 5000 } },
    }),
    "opencode.jsonc": `{
      "mcp": {
        "oc": { "type": "local", "command": ["npx", "-y", "srv"], "environment": { "K": "{env:TOKEN}" } },
        "ocr": { "type": "remote", "url": "https://o.test/mcp" },
        "off": { "type": "local", "command": ["x"], "enabled": false },
      },
    }`,
    ".codex/config.toml": `model = "x"
[mcp_servers.cx]
command = "uvx"
args = ["srv"]
env = { A = "1" }
tool_timeout_sec = 90

[mcp_servers.figma]
url = "https://mcp.figma.com/mcp"
bearer_token_env_var = "FIGMA_TOKEN"
env_http_headers = { "X-Org" = "ORG" }

[mcp_servers.gone]
command = "x"
enabled = false
`,
    ".pi/mcp.json": JSON.stringify({ mcpServers: { pi: { command: "pi-srv" } } }),
    ".roo/mcp.json": JSON.stringify({
      mcpServers: { roo: { command: "roo-srv" }, rooff: { command: "x", disabled: true } },
    }),
    ".kiro/settings/mcp.json": JSON.stringify({
      mcpServers: { kiro: { command: "kiro-srv", autoApprove: [] } },
    }),
    ".mcp.json": JSON.stringify({ mcpServers: { cx: { command: "claude-wins" } } }),
  });
  const servers = loadProjectMcpServers(ws, (w) => warnings.push(w), env);
  expect(Object.keys(servers).sort()).toEqual([
    "cur",
    "cx",
    "figma",
    "gem",
    "kiro",
    "oc",
    "ocr",
    "pi",
    "roo",
    "vs",
  ]);
  expect(servers.vs).toEqual({ command: "node", args: [`${ws}/s.js`] });
  expect(servers.cur).toEqual({ url: "https://c.test/mcp", headers: { Authorization: "Bearer t-1" } });
  expect(servers.gem).toEqual({ url: "https://g.test/mcp", requestTimeoutMs: 5000 });
  expect(servers.oc).toEqual({ command: "npx", args: ["-y", "srv"], env: { K: "t-1" } });
  expect(servers.ocr).toEqual({ url: "https://o.test/mcp" });
  expect(servers.figma).toEqual({
    url: "https://mcp.figma.com/mcp",
    headers: { Authorization: "Bearer f-1", "X-Org": "o-1" },
  });
  expect(servers.pi).toEqual({ command: "pi-srv" });
  // `.mcp.json` of Claude Code wins on a name.
  expect(servers.cx).toEqual({ command: "claude-wins" });
  expect(warnings.join("\n")).toContain('"asks"');
});

test("mcp import reads the user file of a client and keeps the variables for the daemon", () => {
  const home = folder({
    ".cursor/mcp.json": JSON.stringify({ mcpServers: { c: { command: "c", env: { K: "${env:TOKEN}" } } } }),
    ".codex/config.toml": '[mcp_servers.x]\nurl = "https://x.test/mcp"\nbearer_token_env_var = "TOKEN"\n',
  });
  const where = { home, env: {}, platform: "linux" as const };
  expect(MCP_IMPORT_SOURCES).toContain("claude-desktop");
  const cursor = importMcpServers("cursor", where);
  expect(cursor).toEqual({
    file: join(home, ".cursor", "mcp.json"),
    servers: { c: { command: "c", env: { K: "${TOKEN}" } } },
  });
  expect(importMcpServers("codex", where)?.servers).toEqual({
    x: { url: "https://x.test/mcp", headers: { Authorization: "Bearer ${TOKEN}" } },
  });
  expect(importMcpServers("gemini", where)).toBeUndefined();

  const configDir = folder({ "mcp/cursor.json": JSON.stringify({ mcpServers: cursor?.servers }) });
  expect(loadUserMcpServers(configDir, () => {}, env)).toEqual({ c: { command: "c", env: { K: "t-1" } } });
});
