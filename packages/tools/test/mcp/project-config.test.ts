import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadProjectMcpServers } from "../../src/mcp/config.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function workspace(): string {
  const dir = mkdtempSync(join(tmpdir(), "agency-mcp-project-"));
  dirs.push(dir);
  return dir;
}

describe("loadProjectMcpServers", () => {
  test("reads .mcp.json and the files of .agency/mcp, and puts the variables of the environment in", () => {
    const ws = workspace();
    writeFileSync(
      join(ws, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          // The `type` key of Claude Code is accepted and not needed.
          files: {
            type: "stdio",
            command: "npx",
            args: ["-y", "server-files", "${ROOT_DIR}"],
            env: { TOKEN: "${TOKEN:-none}" },
          },
          remote: {
            type: "http",
            url: "https://example.test/mcp",
            headers: { Authorization: "Bearer ${API_TOKEN}" },
          },
        },
      }),
    );
    mkdirSync(join(ws, ".agency", "mcp"), { recursive: true });
    writeFileSync(
      join(ws, ".agency", "mcp", "plug.json"),
      JSON.stringify({ mcpServers: { plug: { command: "node", args: ["server.js"] } } }),
    );
    const servers = loadProjectMcpServers(ws, () => {}, { ROOT_DIR: "/data", API_TOKEN: "t-1" });
    expect(Object.keys(servers).sort()).toEqual(["files", "plug", "remote"]);
    expect(servers.files).toMatchObject({
      command: "npx",
      args: ["-y", "server-files", "/data"],
      env: { TOKEN: "none" },
    });
    expect(servers.remote).toMatchObject({
      url: "https://example.test/mcp",
      headers: { Authorization: "Bearer t-1" },
    });
  });

  test("a file that is not valid is skipped with a warning, and the others load", () => {
    const ws = workspace();
    writeFileSync(join(ws, ".mcp.json"), "{ not json");
    mkdirSync(join(ws, ".agency", "mcp"), { recursive: true });
    writeFileSync(
      join(ws, ".agency", "mcp", "bad.json"),
      JSON.stringify({ mcpServers: { x: { url: "not a url" } } }),
    );
    writeFileSync(
      join(ws, ".agency", "mcp", "ok.json"),
      JSON.stringify({ mcpServers: { ok: { command: "node" } } }),
    );
    const warnings: string[] = [];
    const servers = loadProjectMcpServers(ws, (message) => warnings.push(message), {});
    expect(Object.keys(servers)).toEqual(["ok"]);
    expect(warnings).toHaveLength(2);
  });

  test("a workspace with no file gives no server", () => {
    expect(loadProjectMcpServers(workspace(), () => {}, {})).toEqual({});
  });
});
