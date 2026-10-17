import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFileFallbackBackend } from "@agency/providers";
import { keychainTokenStore } from "@agency/tools";
import { type EntrypointDeps, runEntrypoint } from "../src/entrypoint.ts";

const dirs: string[] = [];
const servers: { stop(force?: boolean): void }[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true);
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const tmp = (name: string): string => {
  const dir = mkdtempSync(join(tmpdir(), `agency-mcplogin-${name}-`));
  dirs.push(dir);
  return dir;
};

/** The sign-in side of an MCP server: metadata, registration, an authorize page that agrees at once, tokens. */
function fakeAuthServer(): string {
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url);
      const base = url.origin;
      switch (url.pathname) {
        case "/mcp":
          return new Response("unauthorized", {
            status: 401,
            headers: { "www-authenticate": `Bearer resource_metadata="${base}/prm"` },
          });
        case "/prm":
          return Response.json({ resource: `${base}/mcp`, authorization_servers: [base] });
        case "/.well-known/oauth-authorization-server":
          return Response.json({
            authorization_endpoint: `${base}/authorize`,
            token_endpoint: `${base}/token`,
            registration_endpoint: `${base}/register`,
          });
        case "/register":
          return Response.json({ client_id: "c1" }, { status: 201 });
        case "/authorize":
          return Response.redirect(
            `${url.searchParams.get("redirect_uri")}?code=k&state=${url.searchParams.get("state")}`,
            302,
          );
        case "/token":
          return Response.json({ access_token: "a1", refresh_token: "r1", expires_in: 600 });
      }
      return new Response("not found", { status: 404 });
    },
  });
  servers.push(server);
  return `http://127.0.0.1:${server.port}/mcp`;
}

function setup() {
  const url = fakeAuthServer();
  const configDir = tmp("cfg");
  writeFileSync(
    join(configDir, "config.jsonc"),
    JSON.stringify({ mcpServers: { notes: { url }, local: { command: "node" } } }),
  );
  const keychain = createFileFallbackBackend(tmp("keys"));
  const out: string[] = [];
  const err: string[] = [];
  const deps: EntrypointDeps = {
    configDir,
    cwd: tmp("ws"),
    env: { AGENCY_HOME: tmp("home") },
    keychain,
    // The browser: it follows the authorize page to the callback of the command.
    openUrl: async (authorizeUrl) => void (await fetch(authorizeUrl)),
    out: (line) => void out.push(line),
    err: (line) => void err.push(line),
  };
  return { url, deps, out, err, store: keychainTokenStore(async () => keychain) };
}

test("mcp login keeps the tokens of a server in the keychain, and mcp logout removes them", async () => {
  const { url, deps, out, store } = setup();
  expect(await runEntrypoint(["mcp", "login", "notes"], deps)).toBe(0);
  expect(out.join("\n")).toContain("Signed in to notes");
  expect((await store.get(url))?.accessToken).toBe("a1");

  expect(await runEntrypoint(["mcp", "logout", "notes"], deps)).toBe(0);
  expect(await store.get(url)).toBeUndefined();
});

test("mcp login names the servers it knows, and refuses a local server", async () => {
  const { deps, err } = setup();
  expect(await runEntrypoint(["mcp", "login", "nope"], deps)).toBe(1);
  expect(err.join("\n")).toContain("notes, local");
  expect(await runEntrypoint(["mcp", "login", "local"], deps)).toBe(1);
  expect(err.join("\n")).toContain("only a server with a url");
  expect(await runEntrypoint(["mcp", "login"], deps)).toBe(1);
});

test("mcp import copies the MCP servers of another client to the user config, and login then finds them", async () => {
  const home = tmp("home");
  const configDir = tmp("config");
  const cursor = join(home, ".cursor");
  require("node:fs").mkdirSync(cursor);
  writeFileSync(
    join(cursor, "mcp.json"),
    JSON.stringify({
      mcpServers: { docs: { url: "https://docs.test/mcp", headers: { "X-Key": "${env:DOCS_KEY}" } } },
    }),
  );
  const out: string[] = [];
  const err: string[] = [];
  const deps: EntrypointDeps = {
    env: { ...process.env, HOME: home, USERPROFILE: home, APPDATA: join(home, "AppData") },
    configDir,
    cwd: tmp("ws"),
    keychain: createFileFallbackBackend(tmp("keys")),
    out: (line) => void out.push(line),
    err: (line) => void err.push(line),
  };
  expect(await runEntrypoint(["mcp", "import", "cursor"], deps)).toBe(0);
  expect(out.at(-1)).toContain("Imported the MCP servers of cursor");
  const saved = JSON.parse(require("node:fs").readFileSync(join(configDir, "mcp", "cursor.json"), "utf8"));
  expect(saved).toEqual({
    mcpServers: { docs: { url: "https://docs.test/mcp", headers: { "X-Key": "${DOCS_KEY}" } } },
  });

  expect(await runEntrypoint(["mcp", "import", "gemini"], deps)).toBe(1);
  expect(err.at(-1)).toContain("gemini");
  expect(await runEntrypoint(["mcp", "import"], deps)).toBe(1);
  expect(err.at(-1)).toContain("cursor (found)");
  // The imported server is a server of the user: logout finds it.
  expect(await runEntrypoint(["mcp", "logout", "docs"], deps)).toBe(0);
});

test("mcp add, add-json, list, get and remove manage the servers of the user and of the workspace", async () => {
  const configDir = tmp("cfg");
  const ws = tmp("ws");
  const out: string[] = [];
  const err: string[] = [];
  const deps: EntrypointDeps = {
    configDir,
    cwd: ws,
    env: { AGENCY_HOME: tmp("home") },
    out: (line) => void out.push(line),
    err: (line) => void err.push(line),
  };
  const run = (...argv: string[]) => runEntrypoint(["mcp", ...argv], deps);
  expect(await run("add", "-e", "KEY=secret", "fs", "--", "npx", "-y", "fs-server", "--root", ".")).toBe(0);
  expect(
    await run("add", "--transport", "http", "-H", "Authorization: Bearer t0", "docs", "https://d.test/mcp"),
  ).toBe(0);
  expect(await run("add-json", "notes", '{"type":"http","url":"https://n.test/mcp"}')).toBe(0);
  expect(await run("add", "-s", "project", "lint", "--", "node", "lint.js")).toBe(0);
  expect(out.at(-1)).toContain("not trusted");
  const saved = JSON.parse(readFileSync(join(configDir, "mcp", "added.json"), "utf8"));
  expect(saved.mcpServers.fs).toEqual({
    type: "stdio",
    command: "npx",
    args: ["-y", "fs-server", "--root", "."],
    env: { KEY: "secret" },
  });
  expect(saved.mcpServers.docs).toEqual({
    type: "http",
    url: "https://d.test/mcp",
    headers: { Authorization: "Bearer t0" },
  });

  out.length = 0;
  expect(await run("list")).toBe(0);
  expect(out).toEqual([
    "lint (project, not started: the workspace is not trusted): node lint.js",
    "fs (user): npx -y fs-server --root .",
    "docs (user): https://d.test/mcp",
    "notes (user): https://n.test/mcp",
  ]);
  expect(await run("get", "fs")).toBe(0);
  expect(out.at(-1)).toContain('"KEY": "***"');
  expect(out.join("\n")).not.toContain("secret");

  // A server over SSE, the older transport, is written with its type.
  expect(await run("add", "-t", "sse", "old", "https://o.test/sse")).toBe(0);
  expect(await run("get", "old")).toBe(0);
  expect(out.at(-1)).toContain('"type": "sse"');
  expect(await run("remove", "old")).toBe(0);

  // A name in use, a bad name, a pair with no separator and a scope that is not known are refused.
  expect(await run("add", "fs", "--", "node")).toBe(1);
  expect(err.at(-1)).toContain("--overwrite");
  expect(await run("add", "--overwrite", "fs", "--", "node")).toBe(0);
  expect(await run("add", "a.b", "--", "node")).toBe(1);
  expect(await run("add", "-e", "NOVALUE", "x", "--", "node")).toBe(1);
  expect(await run("add-json", "y", '{"args":["a"]}')).toBe(1);
  expect(await run("list", "-s", "local")).toBe(1);

  expect(await run("remove", "fs")).toBe(0);
  expect(await run("remove", "lint")).toBe(0);
  expect(JSON.parse(readFileSync(join(ws, ".mcp.json"), "utf8"))).toEqual({ mcpServers: {} });
  expect(await run("remove", "fs")).toBe(1);
  out.length = 0;
  expect(await runEntrypoint(["mcp", "list", "--format", "json"], deps)).toBe(0);
  expect(Object.keys(JSON.parse(out[0] ?? "{}"))).toEqual(["docs", "notes"]);
});
