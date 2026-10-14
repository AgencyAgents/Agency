import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { startMcpServers } from "../../src/mcp/manager.ts";
import { type McpSignIn, type McpTokenStore, signInMcpServer } from "../../src/mcp/oauth.ts";

const capabilities = { tools: "*", pathScopes: "*", network: "*" } as const;
const servers: { stop(force?: boolean): void }[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true);
});

function memoryStore(): McpTokenStore & { data: Map<string, McpSignIn> } {
  const data = new Map<string, McpSignIn>();
  return {
    data,
    get: async (url) => data.get(url),
    set: async (url, signIn) => void data.set(url, signIn),
    delete: async (url) => void data.delete(url),
  };
}

/** An MCP server behind OAuth as the MCP spec describes it: metadata, client registration, PKCE, refresh. */
function fakeServer() {
  const seen = { bearers: [] as string[], resources: [] as string[] };
  let valid = new Set<string>();
  let issued = 0;
  const codes = new Map<string, string>();
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url);
      const base = url.origin;
      const json = (body: unknown, status = 200) => Response.json(body, { status });
      if (url.pathname === "/.well-known/oauth-protected-resource/mcp") {
        return json({ resource: `${base}/mcp`, authorization_servers: [`${base}/auth`] });
      }
      if (url.pathname === "/.well-known/oauth-authorization-server/auth") {
        return json({
          issuer: `${base}/auth`,
          authorization_endpoint: `${base}/auth/authorize`,
          token_endpoint: `${base}/auth/token`,
          registration_endpoint: `${base}/auth/register`,
          code_challenge_methods_supported: ["S256"],
        });
      }
      if (url.pathname === "/auth/register") return json({ client_id: "client-1" }, 201);
      if (url.pathname === "/auth/authorize") {
        const q = url.searchParams;
        if (q.get("client_id") !== "client-1" || q.get("code_challenge_method") !== "S256") {
          return new Response("bad request", { status: 400 });
        }
        seen.resources.push(q.get("resource") ?? "");
        codes.set("code-1", q.get("code_challenge") ?? "");
        return Response.redirect(`${q.get("redirect_uri")}?code=code-1&state=${q.get("state")}`, 302);
      }
      if (url.pathname === "/auth/token") {
        const form = new URLSearchParams(await req.text());
        seen.resources.push(form.get("resource") ?? "");
        if (form.get("grant_type") === "authorization_code") {
          const hash = createHash("sha256")
            .update(form.get("code_verifier") ?? "")
            .digest("base64url");
          if (codes.get(form.get("code") ?? "") !== hash) return json({ error: "invalid_grant" }, 400);
        } else if (form.get("refresh_token") !== "refresh-1") {
          return json({ error: "invalid_grant" }, 400);
        }
        issued += 1;
        const token = `token-${issued}`;
        valid = new Set([token]);
        return json({ access_token: token, refresh_token: "refresh-1", expires_in: 3600 });
      }
      if (url.pathname === "/mcp") {
        const bearer = req.headers.get("authorization") ?? "";
        seen.bearers.push(bearer);
        if (!valid.has(bearer.replace(/^Bearer /, ""))) {
          return new Response("unauthorized", {
            status: 401,
            headers: {
              "www-authenticate": `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"`,
            },
          });
        }
        if (req.method !== "POST") return new Response(null, { status: 405 });
        const message = (await req.json()) as { id?: number; method: string };
        if (message.id === undefined) return new Response(null, { status: 202 });
        const result =
          message.method === "initialize"
            ? {
                protocolVersion: "2025-06-18",
                capabilities: { tools: {} },
                serverInfo: { name: "fake", version: "1" },
              }
            : message.method === "tools/list"
              ? { tools: [{ name: "hello", description: "Says hello.", inputSchema: { type: "object" } }] }
              : {};
        return json({ jsonrpc: "2.0", id: message.id, result });
      }
      return new Response("not found", { status: 404 });
    },
  });
  servers.push(server);
  return {
    url: `http://127.0.0.1:${server.port}/mcp`,
    seen,
    revoke: () => {
      valid = new Set();
    },
  };
}

// The browser: it follows the redirect of the authorize page to the callback of the CLI.
const browser = async (url: string): Promise<void> => {
  await fetch(url);
};

test("a server that needs a sign-in fails with the command that signs in, and works after the sign-in", async () => {
  const fake = fakeServer();
  const store = memoryStore();
  const before = await startMcpServers({
    servers: { notes: { url: fake.url } },
    capabilities,
    tokens: store,
  });
  expect(before.failures.get("notes")).toContain("agency mcp login notes");
  await before.dispose();

  const signIn = await signInMcpServer(fake.url, store, { openUrl: browser });
  expect(signIn.accessToken).toBe("token-1");
  expect(store.data.get(fake.url)?.refreshToken).toBe("refresh-1");
  // RFC 8707: the token is for this server alone.
  expect(fake.seen.resources).toEqual([fake.url, fake.url]);

  const after = await startMcpServers({ servers: { notes: { url: fake.url } }, capabilities, tokens: store });
  expect(after.failures.size).toBe(0);
  expect(after.tools.map((tool) => tool.name)).toEqual(["notes_hello"]);
  expect(fake.seen.bearers.at(-1)).toBe("Bearer token-1");
  await after.dispose();
});

test("a token that has ended, or that the server refuses, is refreshed and the request goes again", async () => {
  const fake = fakeServer();
  const store = memoryStore();
  await signInMcpServer(fake.url, store, { openUrl: browser });

  const signIn = store.data.get(fake.url);
  if (signIn) store.data.set(fake.url, { ...signIn, expiresAt: Date.now() - 1 });
  const expired = await startMcpServers({
    servers: { notes: { url: fake.url } },
    capabilities,
    tokens: store,
  });
  expect(expired.failures.size).toBe(0);
  expect(store.data.get(fake.url)?.accessToken).toBe("token-2");
  await expired.dispose();

  fake.revoke();
  const refused = await startMcpServers({
    servers: { notes: { url: fake.url } },
    capabilities,
    tokens: store,
  });
  expect(refused.failures.size).toBe(0);
  expect(store.data.get(fake.url)?.accessToken).toBe("token-3");
  await refused.dispose();
});

test("a configured authorization header wins: no token of a sign-in is sent", async () => {
  const fake = fakeServer();
  const store = memoryStore();
  await signInMcpServer(fake.url, store, { openUrl: browser });
  const manager = await startMcpServers({
    servers: { notes: { url: fake.url, headers: { Authorization: "Bearer my-own" } } },
    capabilities,
    tokens: store,
  });
  expect(fake.seen.bearers.at(-1)).toBe("Bearer my-own");
  await manager.dispose();
});
