import { afterEach, describe, expect, test } from "bun:test";
import { type HttpGatewayServer, startHttpGateway } from "../src/http-gateway.ts";

const servers: HttpGatewayServer[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
});

function rpc(server: HttpGatewayServer, body: unknown): Promise<Response> {
  return fetch(`http://127.0.0.1:${server.port}/rpc`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

describe("POST /rpc limits", () => {
  test("a body over maxBodyBytes is refused with a typed 413", async () => {
    const server = startHttpGateway({
      handlers: { ping: async () => "pong" },
      maxBodyBytes: 32,
    });
    servers.push(server);

    const res = await rpc(server, { id: "big", method: "ping", params: { pad: "x".repeat(64) } });

    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({
      id: null,
      error: {
        message: "request body exceeds the 32 byte cap",
        code: "BODY_TOO_LARGE",
      },
    });
  });

  test("a body under the cap still dispatches", async () => {
    const server = startHttpGateway({
      handlers: { ping: async (params) => ({ pong: params }) },
      maxBodyBytes: 1024,
    });
    servers.push(server);

    const res = await rpc(server, { id: "ok", method: "ping", params: {} });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: "ok", result: { pong: {} } });
  });

  test("requests past rateLimitMax are refused with a typed 429 plus Retry-After", async () => {
    const server = startHttpGateway({
      handlers: { ping: async () => "pong" },
      rateLimitMax: 2,
      rateLimitWindowMs: 60_000,
    });
    servers.push(server);

    expect((await rpc(server, { id: "a", method: "ping", params: {} })).status).toBe(200);
    expect((await rpc(server, { id: "b", method: "ping", params: {} })).status).toBe(200);
    const limited = await rpc(server, { id: "c", method: "ping", params: {} });

    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).not.toBeNull();
    expect(await limited.json()).toEqual({
      error: {
        message: "rpc rate limit exceeded: at most 2 requests per 60s",
        code: "RATE_LIMITED",
      },
    });
  });

  test("the window resets after rateLimitWindowMs", async () => {
    const server = startHttpGateway({
      handlers: { ping: async () => "pong" },
      rateLimitMax: 1,
      rateLimitWindowMs: 50,
    });
    servers.push(server);

    expect((await rpc(server, { id: "a", method: "ping", params: {} })).status).toBe(200);
    expect((await rpc(server, { id: "b", method: "ping", params: {} })).status).toBe(429);
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect((await rpc(server, { id: "c", method: "ping", params: {} })).status).toBe(200);
  });
});
