import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
