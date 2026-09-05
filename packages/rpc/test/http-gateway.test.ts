import { afterEach, describe, expect, test } from "bun:test";
import { type HttpGatewayServer, type SessionStoreLike, startHttpGateway } from "../src/http-gateway.ts";

const servers: HttpGatewayServer[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
});

function base(server: HttpGatewayServer): string {
  return `http://127.0.0.1:${server.port}`;
}

function rpc(server: HttpGatewayServer, body: unknown, headers?: Record<string, string>): Promise<Response> {
  return fetch(`${base(server)}/rpc`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

/**
 * Reads the SSE body until `until` matches the accumulated text (or the
 * stream ends / the deadline passes). Each read is raced against the
 * deadline so a silent server can't hang the test forever.
 */
async function collectSse(
  res: Response,
  until: (acc: string) => boolean,
  timeoutMs = 3_000,
): Promise<string> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let acc = "";
  const deadline = Date.now() + timeoutMs;

  try {
    while (Date.now() < deadline && !until(acc)) {
      const remaining = deadline - Date.now();
      let timerId: ReturnType<typeof setTimeout> | undefined;
      const timer = new Promise<"timeout">((resolve) => {
        timerId = setTimeout(() => resolve("timeout"), remaining);
      });
      try {
        const result = await Promise.race([reader.read(), timer]);
        if (result === "timeout" || result.done) break;
        acc += decoder.decode(result.value, { stream: true });
      } finally {
        clearTimeout(timerId);
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
  }

  if (!until(acc)) throw new Error(`SSE condition not met in time; received: ${JSON.stringify(acc)}`);
  return acc;
}

/** Reads an SSE body to completion (used after server close ends the stream). */
async function readToEnd(res: Response, timeoutMs = 3_000): Promise<string> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let acc = "";
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    let timerId: ReturnType<typeof setTimeout> | undefined;
    const timer = new Promise<"timeout">((resolve) => {
      timerId = setTimeout(() => resolve("timeout"), deadline - Date.now());
    });
    try {
      const result = await Promise.race([reader.read(), timer]);
      if (result === "timeout" || result.done) break;
      acc += decoder.decode(result.value, { stream: true });
    } finally {
      clearTimeout(timerId);
    }
  }
  return acc;
}

async function waitFor(probe: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (probe()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("condition not met in time");
}

describe("POST /rpc", () => {
  test("returns the handler's result with the request id echoed", async () => {
    const server = startHttpGateway({ handlers: { ping: async (params) => ({ pong: params }) } });
    servers.push(server);

    const res = await rpc(server, { id: "req-1", method: "ping", params: { n: 7 } });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: "req-1", result: { pong: { n: 7 } } });
  });

  test("a handler's thrown error surfaces as { id, error }, not a hang", async () => {
    const server = startHttpGateway({
      handlers: {
        boom: async () => {
          const error = new Error("something broke");
          (error as Error & { code?: string }).code = "E_TEST";
          throw error;
        },
      },
    });
    servers.push(server);

    const res = await rpc(server, { id: "req-2", method: "boom", params: {} });

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({
      id: "req-2",
      error: { message: "something broke", code: "E_TEST" },
    });
  });

  test("calling an unregistered method answers with the TCP transport's message", async () => {
    const server = startHttpGateway({ handlers: {} });
    servers.push(server);

    const res = await rpc(server, { id: "req-3", method: "nonexistent", params: {} });

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ id: "req-3", error: { message: "unknown method: nonexistent" } });
  });

  test("malformed bodies are rejected with 400", async () => {
    const server = startHttpGateway({ handlers: {} });
    servers.push(server);

    const badJson = await rpc(server, "{not json");
    expect(badJson.status).toBe(400);
    await badJson.text();

    const notAnObject = await rpc(server, [1, 2, 3]);
    expect(notAnObject.status).toBe(400);
    await notAnObject.text();

    const missingMethod = await rpc(server, { id: "x", params: {} });
    expect(missingMethod.status).toBe(400);
    await missingMethod.text();
  });

  test("GET /rpc is a 405 with an Allow header", async () => {
    const server = startHttpGateway({ handlers: {} });
    servers.push(server);

    const res = await fetch(`${base(server)}/rpc`);
    expect(res.status).toBe(405);
    expect(res.headers.get("Allow")).toBe("POST");
    await res.text();
  });
});

describe("GET /health and GET /doc", () => {
  test("health reports ok and the live subscriber count", async () => {
    const server = startHttpGateway({ handlers: {} });
    servers.push(server);

    const res = await fetch(`${base(server)}/health`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; subscribers: number };
    expect(body.ok).toBe(true);
    expect(body.subscribers).toBe(0);
  });

  test("doc is an OpenAPI document describing the gateway's endpoints", async () => {
    const server = startHttpGateway({ handlers: {} });
    servers.push(server);

    const res = await fetch(`${base(server)}/doc`);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("application/json");

    const doc = (await res.json()) as { openapi: string; paths: Record<string, unknown> };
    expect(doc.openapi).toBe("3.1.0");
    expect(Object.keys(doc.paths).sort()).toEqual(["/doc", "/events", "/health", "/rpc", "/sync-events"]);
  });

  test("unknown paths are a JSON 404", async () => {
    const server = startHttpGateway({ handlers: {} });
    servers.push(server);

    const res = await fetch(`${base(server)}/nope`);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: { message: "no such endpoint: /nope" } });
  });
});

describe("GET /events (SSE)", () => {
  test("a subscriber receives the events for its stream, with the TCP event name", async () => {
    const server = startHttpGateway({ handlers: {} });
    servers.push(server);

    const res = await fetch(`${base(server)}/events?stream=turn.abc`);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/event-stream");
    expect(res.headers.get("Cache-Control")).toContain("no-cache");

    server.publish("turn.abc", { type: "text_delta", text: "hi" });
    const acc = await collectSse(res, (text) => text.includes("event: turn.abc"));

    expect(acc).toContain('event: turn.abc\ndata: {"type":"text_delta","text":"hi"}\n\n');
  });

  test("a bare turn id in the subscription matches turn.<id> events", async () => {
    const server = startHttpGateway({ handlers: {} });
    servers.push(server);

    const res = await fetch(`${base(server)}/events?stream=abc`);
    server.publish("turn.abc", { n: 1 });

    const acc = await collectSse(res, (text) => text.includes("event: turn.abc"));
    expect(acc).toContain('data: {"n":1}');
  });

  test("two subscribers on different streams see only their own events", async () => {
    const server = startHttpGateway({ handlers: {} });
    servers.push(server);

    const resA = await fetch(`${base(server)}/events?stream=turn.a`);
    const resB = await fetch(`${base(server)}/events?stream=turn.b`);

    server.publish("turn.a", { who: "a" });
    server.publish("turn.b", { who: "b" });

    const [accA, accB] = await Promise.all([
      collectSse(resA, (text) => text.includes("event: turn.a")),
      collectSse(resB, (text) => text.includes("event: turn.b")),
    ]);

    expect(accA).toContain('data: {"who":"a"}');
    expect(accA).not.toContain("turn.b");
    expect(accB).toContain('data: {"who":"b"}');
    expect(accB).not.toContain("turn.a");
  });

  test("a subscriber with no stream filter receives every event", async () => {
    const server = startHttpGateway({ handlers: {} });
    servers.push(server);

    const res = await fetch(`${base(server)}/events`);
    server.publish("turn.x", { n: 1 });
    server.publish("workspace.updated", { n: 2 });

    const acc = await collectSse(res, (text) => text.includes("workspace.updated"));
    expect(acc).toContain("event: turn.x");
    expect(acc).toContain("event: workspace.updated");
  });

  test("keepalive comments keep the connection alive", async () => {
    const server = startHttpGateway({ handlers: {}, keepAliveMs: 40 });
    servers.push(server);

    const res = await fetch(`${base(server)}/events?stream=turn.abc`);
    const acc = await collectSse(res, (text) => text.includes(": keepalive"), 2_000);
    expect(acc).toContain(": connected");
    expect(acc).toContain(": keepalive");
  });

  test("close() ends every open SSE stream", async () => {
    const server = startHttpGateway({ handlers: {} });
    const res = await fetch(`${base(server)}/events?stream=turn.abc`);
    await waitFor(() => server.subscriberCount === 1);

    await server.close();
    const acc = await readToEnd(res);

    expect(acc).toContain(": connected");
    expect(server.subscriberCount).toBe(0);
  });

  test("a client disconnect unregisters its subscription", async () => {
    const server = startHttpGateway({ handlers: {} });
    const controller = new AbortController();
    await fetch(`${base(server)}/events?stream=turn.abc`, { signal: controller.signal });
    await waitFor(() => server.subscriberCount === 1);

    controller.abort();
    await waitFor(() => server.subscriberCount === 0);
  });

  test("subscriberCount tracks concurrent subscriptions", async () => {
    const server = startHttpGateway({ handlers: {} });
    servers.push(server);
    const resA = await fetch(`${base(server)}/events?stream=turn.a`);
    const resB = await fetch(`${base(server)}/events?stream=turn.b`);
    await waitFor(() => server.subscriberCount === 2);

    await resA.body!.cancel();
    await waitFor(() => server.subscriberCount === 1);
    await resB.body!.cancel();
    await waitFor(() => server.subscriberCount === 0);
  });
});

describe("auth", () => {
  test("without a configured token the gateway accepts anonymous callers", async () => {
    const server = startHttpGateway({ handlers: { ping: async () => "pong" } });
    servers.push(server);

    const res = await rpc(server, { id: "req-1", method: "ping" });
    expect(res.status).toBe(200);
  });

  test("a configured token rejects missing and wrong credentials on RPC and events", async () => {
    const server = startHttpGateway({ handlers: { ping: async () => "pong" }, token: "secret" });
    servers.push(server);

    const noHeader = await rpc(server, { id: "req-1", method: "ping" });
    expect(noHeader.status).toBe(401);
    expect(noHeader.headers.get("WWW-Authenticate")).toBe("Bearer");
    await noHeader.text();

    const wrongToken = await rpc(server, { id: "req-1", method: "ping" }, { Authorization: "Bearer nope" });
    expect(wrongToken.status).toBe(401);
    await wrongToken.text();

    // Health is always open — clients probe liveness without a token.
    const health = await fetch(`${base(server)}/health`);
    expect(health.status).toBe(200);
    await health.text();

    const events = await fetch(`${base(server)}/events?stream=turn.abc`);
    expect(events.status).toBe(401);
    await events.text();
  });

  test("the correct bearer token is accepted on every endpoint", async () => {
    const server = startHttpGateway({ handlers: { ping: async () => "pong" }, token: "secret" });
    servers.push(server);

    const rpcRes = await rpc(server, { id: "req-1", method: "ping" }, { Authorization: "Bearer secret" });
    expect(rpcRes.status).toBe(200);
    expect(await rpcRes.json()).toEqual({ id: "req-1", result: "pong" });

    const health = await fetch(`${base(server)}/health`, { headers: { Authorization: "Bearer secret" } });
    expect(health.status).toBe(200);

    const doc = await fetch(`${base(server)}/doc`, { headers: { Authorization: "Bearer secret" } });
    expect(doc.status).toBe(200);

    const events = await fetch(`${base(server)}/events?stream=turn.abc`, {
      headers: { Authorization: "Bearer secret" },
    });
    expect(events.status).toBe(200);
    expect(events.headers.get("Content-Type")).toContain("text/event-stream");
    await events.body!.cancel();
  });

  test("the ?token= query param is accepted for EventSource-style clients", async () => {
    const server = startHttpGateway({ handlers: {}, token: "secret" });
    servers.push(server);

    const events = await fetch(`${base(server)}/events?stream=turn.abc&token=secret`);
    expect(events.status).toBe(200);
    await events.body!.cancel();

    const wrong = await fetch(`${base(server)}/events?stream=turn.abc&token=nope`);
    expect(wrong.status).toBe(401);
    await wrong.text();
  });

  test("CORS preflight is answered before auth", async () => {
    const server = startHttpGateway({ handlers: {}, token: "secret" });
    servers.push(server);

    const res = await fetch(`${base(server)}/rpc`, {
      method: "OPTIONS",
      headers: { Origin: "http://localhost:5173", "Access-Control-Request-Method": "POST" },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(res.headers.get("Access-Control-Allow-Headers")).toContain("Authorization");
  });
});

describe("CORS", () => {
  test("responses carry CORS headers for webview clients", async () => {
    const server = startHttpGateway({ handlers: { ping: async () => "pong" } });
    servers.push(server);

    const res = await rpc(server, { id: "req-1", method: "ping" });
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
  });

  test("CORS can be disabled", async () => {
    const server = startHttpGateway({ handlers: { ping: async () => "pong" }, cors: false });
    servers.push(server);

    const res = await rpc(server, { id: "req-1", method: "ping" });
    expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });
});

describe("GET /sync-events (SSE replay)", () => {
  function mockStore(entries: Record<string, unknown>[]): SessionStoreLike {
    return {
      load: () => entries as { id: string; type: string; createdAt: string; [key: string]: unknown }[],
    };
  }

  test("streams session entries as SSE events with a completion frame", async () => {
    const entries = [
      { id: "e1", type: "message", createdAt: "2025-01-01T00:00:00Z", parentId: null, schemaVersion: 2 },
      { id: "e2", type: "message", createdAt: "2025-01-01T00:00:01Z", parentId: "e1", schemaVersion: 2 },
    ];
    const server = startHttpGateway({ handlers: {}, store: mockStore(entries) });
    servers.push(server);

    const res = await fetch(`${base(server)}/sync-events?sessionId=test-session`);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/event-stream");

    const acc = await collectSse(res, (text) => text.includes("sync-complete"), 3_000);

    expect(acc).toContain('event: sync-entry\ndata: {"id":"e1"');
    expect(acc).toContain('event: sync-entry\ndata: {"id":"e2"');
    expect(acc).toContain('event: sync-complete\ndata: {"count":2}');
  });

  test("returns 400 when sessionId is missing", async () => {
    const server = startHttpGateway({ handlers: {}, store: mockStore([]) });
    servers.push(server);

    const res = await fetch(`${base(server)}/sync-events`);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toContain("sessionId");
  });

  test("returns 404 when session has no entries", async () => {
    const server = startHttpGateway({ handlers: {}, store: mockStore([]) });
    servers.push(server);

    const res = await fetch(`${base(server)}/sync-events?sessionId=nonexistent`);
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toContain("session not found");
  });

  test("returns 501 when no store is configured", async () => {
    const server = startHttpGateway({ handlers: {} });
    servers.push(server);

    const res = await fetch(`${base(server)}/sync-events?sessionId=test`);
    expect(res.status).toBe(501);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toContain("no session store configured");
  });

  test("requires auth when token is configured", async () => {
    const entries = [
      { id: "e1", type: "message", createdAt: "2025-01-01T00:00:00Z", parentId: null, schemaVersion: 2 },
    ];
    const server = startHttpGateway({ handlers: {}, store: mockStore(entries), token: "secret" });
    servers.push(server);

    const noAuth = await fetch(`${base(server)}/sync-events?sessionId=test`);
    expect(noAuth.status).toBe(401);
    await noAuth.text();

    const withAuth = await fetch(`${base(server)}/sync-events?sessionId=test&token=secret`);
    expect(withAuth.status).toBe(200);
    await withAuth.body!.cancel();
  });

  test("GET /sync-events is a 405 with an Allow header", async () => {
    const server = startHttpGateway({ handlers: {}, store: mockStore([]) });
    servers.push(server);

    const res = await fetch(`${base(server)}/sync-events`, { method: "POST" });
    expect(res.status).toBe(405);
    expect(res.headers.get("Allow")).toBe("GET");
    await res.text();
  });
});
