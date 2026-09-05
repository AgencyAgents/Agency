import { afterEach, describe, expect, test } from "bun:test";
import { connectToDaemon, type DaemonClient } from "../src/client.ts";
import { PROTOCOL_VERSION } from "../src/protocol.ts";
import { type DaemonServer, startDaemonServer } from "../src/server.ts";

let server: DaemonServer | undefined;
const clients: DaemonClient[] = [];

afterEach(async () => {
  // Server first: destroy()ing its sockets while a client graceful FIN
  // (from client.close) is still being processed races the Windows TCP
  // layer (process segfaults/hangs under bun). Closing the server while
  // client sockets are fully open is safe; the client closes after that
  // are no-ops on already-dead sockets. The trailing settle lets Bun's
  // native socket disposal (which lags the JS close events) finish
  // before the next test allocates new sockets on top of it.
  if (server) {
    const s = server;
    server = undefined;
    await s.close();
  }
  for (const client of clients.splice(0)) await client.close();
});

describe("startDaemonServer + connectToDaemon", () => {
  test("a client can call a registered method and get its result back", async () => {
    server = await startDaemonServer({
      handlers: { ping: async (params) => ({ pong: params }) },
    });
    const client = await connectToDaemon(server.port);
    clients.push(client);

    const result = await client.call("ping", { n: 1 });
    expect(result).toEqual({ pong: { n: 1 } });
  });

  test("a handler's thrown error surfaces as a rejected call, not a hang", async () => {
    server = await startDaemonServer({
      handlers: {
        boom: async () => {
          throw new Error("something broke");
        },
      },
    });
    const client = await connectToDaemon(server.port);
    clients.push(client);

    await expect(client.call("boom", {})).rejects.toThrow("something broke");
  });

  test("calling an unregistered method rejects with a clear message", async () => {
    server = await startDaemonServer({ handlers: {} });
    const client = await connectToDaemon(server.port);
    clients.push(client);

    await expect(client.call("nonexistent", {})).rejects.toThrow(/unknown method/);
  });

  test("broadcast pushes an event to a connected client", async () => {
    server = await startDaemonServer({ handlers: {} });
    const client = await connectToDaemon(server.port);
    clients.push(client);

    const received = new Promise((resolve) => client.on("turn.delta", resolve));
    server.broadcast("turn.delta", { text: "hi" });

    expect(await received).toEqual({ text: "hi" });
  });

  test("multiple clients can connect and call independently", async () => {
    server = await startDaemonServer({
      handlers: { echo: async (params) => params },
    });
    const a = await connectToDaemon(server.port);
    const b = await connectToDaemon(server.port);
    clients.push(a, b);

    const [ra, rb] = await Promise.all([a.call("echo", { who: "a" }), b.call("echo", { who: "b" })]);
    expect(ra).toEqual({ who: "a" });
    expect(rb).toEqual({ who: "b" });
  });

  test("a client on an incompatible protocol version is refused", async () => {
    server = await startDaemonServer({ handlers: {} });

    // Simulate an old client by connecting raw and sending a stale version.
    const { createConnection } = await import("node:net");
    const socket = createConnection(server.port, "127.0.0.1");
    // Swallow ECONNRESET: the server answers then ends its side while we
    // destroy ours, and an unhandled 'error' would take down the process.
    socket.on("error", () => {});
    await new Promise<void>((resolve) => socket.once("connect", resolve));

    const ackPromise = new Promise<string>((resolve) => {
      socket.once("data", (chunk) => resolve(chunk.toString()));
    });
    socket.write(`${JSON.stringify({ type: "hello", version: PROTOCOL_VERSION + 999 })}\n`);

    const ack = JSON.parse(await ackPromise);
    expect(ack).toMatchObject({ type: "hello_ack", compatible: false });
    socket.destroy();
  });

  test("onClientCount reflects connects and disconnects", async () => {
    const counts: number[] = [];
    server = await startDaemonServer({ handlers: {}, onClientCount: (n) => counts.push(n) });

    const client = await connectToDaemon(server.port);
    await client.close();
    // give the server a tick to observe the close event
    await new Promise((r) => setTimeout(r, 20));

    expect(counts).toEqual([1, 0]);
  });
});

describe("TCP auth (A3)", () => {
  test("a daemon with a token refuses a hello without it", async () => {
    server = await startDaemonServer({ handlers: {}, token: "sekrit" });

    let rejection: string | undefined;
    try {
      await connectToDaemon(server.port, "127.0.0.1", {});
    } catch (error) {
      rejection = error instanceof Error ? error.message : String(error);
    }
    expect(rejection).toMatch(/auth token/);
  });

  test("a hello carrying the right token is admitted and can call", async () => {
    server = await startDaemonServer({ handlers: { ping: async () => "pong" }, token: "sekrit" });
    const client = await connectToDaemon(server.port, "127.0.0.1", { token: "sekrit" });
    clients.push(client);

    expect(await client.call("ping", {})).toBe("pong");
  });

  test("a server without a token admits tokenless clients (unchanged behavior)", async () => {
    server = await startDaemonServer({ handlers: { ping: async () => "pong" } });
    const client = await connectToDaemon(server.port);
    clients.push(client);

    expect(await client.call("ping", {})).toBe("pong");
  });
});

describe("per-client subscriptions over TCP (A3)", () => {
  test("a subscribed client only receives matching events", async () => {
    server = await startDaemonServer({ handlers: {} });
    const a = await connectToDaemon(server.port);
    const b = await connectToDaemon(server.port);
    clients.push(a, b);

    const gotA: unknown[] = [];
    const gotB: unknown[] = [];
    a.on("turn.1", (payload) => gotA.push(payload));
    b.on("turn.2", (payload) => gotB.push(payload));
    a.subscribe("turn.1");
    b.subscribe("turn.2");
    // Subscriptions are fire-and-forget frames; give the server a tick to
    // register them before broadcasting.
    await new Promise((r) => setTimeout(r, 20));

    server.broadcast("turn.1", { text: "for a" });
    server.broadcast("turn.2", { text: "for b" });
    await new Promise((r) => setTimeout(r, 20));

    expect(gotA).toEqual([{ text: "for a" }]);
    expect(gotB).toEqual([{ text: "for b" }]);
  });

  test("a client that never subscribes still receives everything (back-compat)", async () => {
    server = await startDaemonServer({ handlers: {} });
    const client = await connectToDaemon(server.port);
    clients.push(client);

    const got: unknown[] = [];
    client.on("some.event", (payload) => got.push(payload));

    server.broadcast("some.event", { n: 1 });
    await new Promise((r) => setTimeout(r, 20));

    expect(got).toEqual([{ n: 1 }]);
  });
});
