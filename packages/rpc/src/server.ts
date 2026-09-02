import { randomUUID } from "node:crypto";
import { createServer, type Socket } from "node:net";
import {
  encodeFrame,
  FrameDecoder,
  matchesSubscription,
  PROTOCOL_VERSION,
  type RpcMessage,
} from "./protocol.ts";
import { FrameWriter } from "./writer.ts";

/** Per-call context: which connected client issued the request. */
export interface MethodContext {
  clientId: string;
}

export type MethodHandler = (params: unknown, context: MethodContext) => Promise<unknown>;

export interface DaemonServerOptions {
  handlers: Record<string, MethodHandler>;
  /** Fires whenever the connected-client count changes. */
  onClientCount?: (count: number) => void;
  /** Fires when a handshake-completed client disconnects; the daemon uses
   *  this to cancel the turns that client had in flight (A3). */
  onClientDisconnect?: (clientId: string) => void;
  /**
   * Per-instance auth token (A3). When set, a connection's hello must carry
   * the same token or the handshake is refused — loopback binding alone
   * lets any local process execute tools otherwise. Clients read the token
   * from the instance file (chmod-restricted on creation).
   */
  token?: string;
}

export interface DaemonServer {
  readonly port: number;
  /** The auth token this server checks hello frames against (undefined = open). */
  readonly token?: string;
  /** Pushes an event frame to every client whose subscription matches. */
  broadcast(event: string, payload: unknown): void;
  close(): Promise<void>;
}

interface ClientConnection {
  id: string;
  socket: Socket;
  decoder: FrameDecoder;
  writer: FrameWriter;
  handshaked: boolean;
  /** undefined = wildcard (every event, pre-A3 behavior); otherwise the
   *  explicit subscription set (exact names / bare turn ids). */
  subscriptions: Set<string> | undefined;
}

/**
 * The generic transport half of R1's daemon: dispatches named RPC methods
 * and pushes events, over TCP loopback rather than a Unix socket/named pipe.
 * Loopback TCP behaves identically on Windows/macOS/Linux with no
 * platform-specific path handling, at the cost of binding a local port
 * instead of a filesystem/pipe handle, an acceptable trade for a
 * localhost-only daemon that already refuses non-loopback connections.
 *
 * Hardening (A3): per-connection auth token check on hello, per-client event
 * subscriptions (two terminals on one workspace see only their own turn
 * streams), bounded send queues for backpressure, and client-disconnect
 * notification so in-flight turns can be cancelled.
 */
export async function startDaemonServer(options: DaemonServerOptions): Promise<DaemonServer> {
  const clients = new Map<string, ClientConnection>();

  function setClientCount() {
    options.onClientCount?.(clients.size);
  }

  const server = createServer((socket) => {
    const conn: ClientConnection = {
      id: randomUUID(),
      socket,
      decoder: new FrameDecoder(),
      writer: new FrameWriter(socket, { onOverflow: () => socket.destroy() }),
      handshaked: false,
      subscriptions: undefined,
    };

    socket.on("data", (chunk) => {
      let messages: RpcMessage[];
      try {
        messages = conn.decoder.push(chunk.toString("utf8"));
      } catch {
        // Oversized or unparseable frame: fail closed for this connection.
        socket.destroy();
        return;
      }

      for (const message of messages) {
        if (!conn.handshaked) {
          if (message.type !== "hello") {
            socket.destroy();
            return;
          }
          const compatible = message.version === PROTOCOL_VERSION;
          const authorized = options.token === undefined || message.token === options.token;
          conn.writer.write(
            encodeFrame({ type: "hello_ack", version: PROTOCOL_VERSION, compatible, authorized }),
          );
          if (!compatible || !authorized) {
            socket.end();
            return;
          }
          conn.handshaked = true;
          clients.set(conn.id, conn);
          setClientCount();
          continue;
        }

        switch (message.type) {
          case "request": {
            const handler = options.handlers[message.method];
            if (!handler) {
              conn.writer.write(
                encodeFrame({
                  type: "response_error",
                  id: message.id,
                  error: { message: `unknown method: ${message.method}` },
                }),
              );
              break;
            }
            handler(message.params, { clientId: conn.id })
              .then((result) => conn.writer.write(encodeFrame({ type: "response", id: message.id, result })))
              .catch((error: unknown) => {
                const code =
                  error && typeof error === "object" && "code" in error
                    ? String(error.code)
                    : undefined;
                const errMessage = error instanceof Error ? error.message : String(error);
                conn.writer.write(
                  encodeFrame({
                    type: "response_error",
                    id: message.id,
                    error: { message: errMessage, code },
                  }),
                );
              });
            break;
          }

          case "subscribe":
            if (message.event === undefined) {
              conn.subscriptions = undefined; // back to wildcard
            } else {
              (conn.subscriptions ??= new Set()).add(message.event);
            }
            break;

          case "unsubscribe":
            if (message.event === undefined) {
              conn.subscriptions = new Set(); // receive nothing
            } else {
              conn.subscriptions?.delete(message.event);
            }
            break;

          case "ping":
            conn.writer.write(encodeFrame({ type: "pong" }));
            break;
        }
      }
    });

    socket.on("close", () => {
      if (clients.delete(conn.id)) {
        setClientCount();
        options.onClientDisconnect?.(conn.id);
      }
      conn.writer.reset();
    });
    socket.on("error", () => socket.destroy());
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });

  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;

  return {
    port,
    token: options.token,
    broadcast(event, payload) {
      const frame = encodeFrame({ type: "event", event, payload });
      for (const conn of clients.values()) {
        if (conn.socket.destroyed) continue;
        if (conn.subscriptions !== undefined && !matchesSubscription([...conn.subscriptions], event)) {
          continue;
        }
        conn.writer.write(frame);
      }
    },
    close() {
      for (const conn of clients.values()) conn.socket.destroy();
      return new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
