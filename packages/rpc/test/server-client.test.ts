import { describe, expect, test, afterEach } from "bun:test";
import { startDaemonServer, type DaemonServer } from "../src/server.ts";
import { connectToDaemon, type DaemonClient } from "../src/client.ts";
import { PROTOCOL_VERSION } from "../src/protocol.ts";

let server: DaemonServer | undefined;
const clients: DaemonClient[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) await client.close();
  if (server) {
    await server.close();
    server = undefined;
  }
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
