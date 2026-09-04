import { afterEach, describe, expect, test } from "bun:test";
import { createServer, type Server, type Socket } from "node:net";
import { connectToDaemon, type DaemonClient } from "../src/client.ts";
import { encodeFrame, PROTOCOL_VERSION } from "../src/protocol.ts";

/** Minimal mock daemon: accepts one connection, handshakes, then forwards
 *  every received frame to `onFrame`. The caller controls lifecycle. */
function mockDaemon(opts: {
  onFrame?: (line: string, socket: Socket) => void;
  onConnect?: (socket: Socket) => void;
  compatible?: boolean;
  authorized?: boolean;
}): Promise<{ server: Server; port: number }> {
  return new Promise((resolve) => {
    const server = createServer((socket) => {
      opts.onConnect?.(socket);
      let buffer = "";
      socket.on("data", (chunk: Buffer) => {
        buffer += chunk.toString("utf8");
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.trim()) continue;
          const msg = JSON.parse(line) as Record<string, unknown>;
          if (msg.type === "hello") {
            socket.write(
              encodeFrame({
                type: "hello_ack",
                version: PROTOCOL_VERSION,
                compatible: opts.compatible ?? true,
                authorized: opts.authorized,
              }),
            );
          }
          opts.onFrame?.(line, socket);
        }
      });
    });
    server.listen(0, "127.0.0.1", () => {
      resolve({ server, port: (server.address() as { port: number }).port });
    });
  });
}

/** Helper: wait for a condition to be true (poll every 10ms). */
async function waitFor(condition: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("waitFor condition never became true");
}

const clients: DaemonClient[] = [];
const servers: Server[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) {
    try {
      await client.close();
    } catch {
      // best-effort
    }
  }
  for (const server of servers.splice(0)) {
    try {
      server.close();
    } catch {
      // best-effort
    }
  }
});

describe("DaemonClient — outbox", () => {
  test("outbox overflow fails pending calls with 'connection to daemon closed'", async () => {
    // Set up a mock daemon that accepts the handshake then drops.
    let serverSocket: Socket | undefined;
    const { server, port } = await mockDaemon({
      onConnect: (sock) => {
        serverSocket = sock;
      },
    });
    servers.push(server);

    const client = await connectToDaemon(port, "127.0.0.1", { reconnect: false });
    clients.push(client);

    // Kill the TCP connection behind the client's back.
    serverSocket?.destroy();
    await new Promise((r) => setTimeout(r, 50));

    // Make enough calls to overflow the outbox (MAX_OUTBOX_FRAMES = 256).
    // Each call queues a frame; the 257th should trigger overflow.
    const calls: Promise<unknown>[] = [];
    for (let i = 0; i < 257; i++) {
      calls.push(client.call(`method_${i}`, {}).catch((e) => e));
    }

    const results = await Promise.all(calls);
    // At least the last few should fail with "connection to daemon closed".
    const failures = results.filter(
      (r) => r instanceof Error && r.message.includes("connection to daemon closed"),
    );
    expect(failures.length).toBeGreaterThan(0);
  }, 10_000);
});

describe("DaemonClient — ping keepalive", () => {
  test("pings are sent while the connection is idle", async () => {
    const receivedFrames: string[] = [];
    const { server, port } = await mockDaemon({
      onFrame: (line) => {
        receivedFrames.push(line);
      },
    });
    servers.push(server);

    // Use a short heartbeatMs so pings fire quickly.
    const client = await connectToDaemon(port, "127.0.0.1", { heartbeatMs: 200 });
    clients.push(client);

    // Wait for at least one ping to arrive.
    await waitFor(() => receivedFrames.some((f) => f.includes('"type":"ping"')), 3_000);

    expect(receivedFrames.filter((f) => f.includes('"type":"ping"')).length).toBeGreaterThanOrEqual(1);
  }, 10_000);

  test("pong from server keeps the connection alive (no reconnect triggered)", async () => {
    const receivedPings: string[] = [];
    let serverSocket: Socket | undefined;
    const { server, port } = await mockDaemon({
      onConnect: (sock) => {
        serverSocket = sock;
      },
      onFrame: (line, sock) => {
        if (line.includes('"type":"ping"')) {
          receivedPings.push(line);
          // Reply with pong to keep the connection alive.
          sock.write(encodeFrame({ type: "pong" }));
        }
      },
    });
    servers.push(server);

    const client = await connectToDaemon(port, "127.0.0.1", { heartbeatMs: 200 });
    clients.push(client);

    // Wait for a few pings to arrive and be answered.
    await waitFor(() => receivedPings.length >= 2, 5_000);

    // The connection should still be alive — the socket isn't destroyed.
    expect(serverSocket?.destroyed).toBe(false);
  }, 10_000);
});

describe("DaemonClient — reconnect with subscription resend", () => {
  test("client reconnects and resends subscriptions after connection drop", async () => {
    // Phase 1: first connection — accept handshake, receive subscribe.
    const subscriptionsOnFirst: string[] = [];
    const subscriptionsOnSecond: string[] = [];
    let phase = 1;

    const server = createServer((socket) => {
      let buffer = "";
      const handler = (chunk: Buffer) => {
        buffer += chunk.toString("utf8");
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.trim()) continue;
          const msg = JSON.parse(line) as Record<string, unknown>;
          if (msg.type === "hello") {
            socket.write(
              encodeFrame({
                type: "hello_ack",
                version: PROTOCOL_VERSION,
                compatible: true,
              }),
            );
          } else if (msg.type === "subscribe") {
            if (phase === 1) {
              subscriptionsOnFirst.push(msg.event as string);
              // After receiving the subscribe, kill the connection to
              // trigger reconnect.
              setTimeout(() => socket.destroy(), 20);
            } else {
              subscriptionsOnSecond.push(msg.event as string);
            }
          }
        }
      };
      socket.on("data", handler);
    });

    const port = await new Promise<number>((resolve) =>
      server.listen(0, "127.0.0.1", () => resolve((server.address() as { port: number }).port)),
    );
    servers.push(server);

    const client = await connectToDaemon(port, "127.0.0.1", { heartbeatMs: 100, reconnect: true });
    clients.push(client);

    // Subscribe to an event.
    client.subscribe("turn.test");

    // Wait for the first connection to receive the subscribe and get killed.
    await waitFor(() => subscriptionsOnFirst.length > 0, 2_000);

    // Now the client should reconnect. The same server will accept the
    // second connection. Switch to phase 2 so we track subscriptions
    // separately.
    phase = 2;

    // Wait for the client to reconnect and resend the subscription.
    await waitFor(() => subscriptionsOnSecond.length > 0, 5_000);

    expect(subscriptionsOnFirst).toContain("turn.test");
    expect(subscriptionsOnSecond).toContain("turn.test");
    expect(subscriptionsOnSecond.length).toBeGreaterThanOrEqual(1);
  }, 15_000);

  test("reconnect resends multiple subscriptions", async () => {
    const subsOnReconnect: string[] = [];
    let phase = 1;

    const server = createServer((socket) => {
      let buffer = "";
      socket.on("data", (chunk: Buffer) => {
        buffer += chunk.toString("utf8");
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.trim()) continue;
          const msg = JSON.parse(line) as Record<string, unknown>;
          if (msg.type === "hello") {
            socket.write(
              encodeFrame({
                type: "hello_ack",
                version: PROTOCOL_VERSION,
                compatible: true,
              }),
            );
          } else if (msg.type === "subscribe") {
            if (phase === 1) {
              // After first subscribe, kill connection.
              setTimeout(() => socket.destroy(), 20);
            } else {
              subsOnReconnect.push(msg.event as string);
            }
          }
        }
      });
    });

    const port = await new Promise<number>((resolve) =>
      server.listen(0, "127.0.0.1", () => resolve((server.address() as { port: number }).port)),
    );
    servers.push(server);

    const client = await connectToDaemon(port, "127.0.0.1", { heartbeatMs: 100, reconnect: true });
    clients.push(client);

    // Subscribe to multiple events before the connection drops.
    client.subscribe("turn.a");
    client.subscribe("turn.b");
    client.subscribe("turn.c");

    // Wait for first subscribe to arrive (triggers disconnect).
    await new Promise((r) => setTimeout(r, 300));
    phase = 2;

    // Wait for reconnection and resubscription.
    await waitFor(() => subsOnReconnect.length >= 3, 5_000);

    expect(subsOnReconnect).toContain("turn.a");
    expect(subsOnReconnect).toContain("turn.b");
    expect(subsOnReconnect).toContain("turn.c");
  }, 15_000);
});
