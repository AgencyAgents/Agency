import { createServer, type Socket } from "node:net";
import { PROTOCOL_VERSION, encodeFrame, FrameDecoder, type RpcMessage } from "./protocol.ts";

export type MethodHandler = (params: unknown) => Promise<unknown>;

export interface DaemonServerOptions {
  handlers: Record<string, MethodHandler>;
  /** Fires whenever the connected-client count changes. */
  onClientCount?: (count: number) => void;
}

export interface DaemonServer {
  readonly port: number;
  /** Pushes an event frame to every client that's completed the handshake. */
  broadcast(event: string, payload: unknown): void;
  close(): Promise<void>;
}

/**
 * The generic transport half of R1's daemon: dispatches named RPC methods
 * and pushes events, over TCP loopback rather than a Unix socket/named pipe.
 * Loopback TCP behaves identically on Windows/macOS/Linux with no
 * platform-specific path handling, at the cost of binding a local port
 * instead of a filesystem/pipe handle — an acceptable trade for a
 * localhost-only daemon that already refuses non-loopback connections.
 */
export async function startDaemonServer(options: DaemonServerOptions): Promise<DaemonServer> {
  const clients = new Set<Socket>();

  function setClientCount() {
    options.onClientCount?.(clients.size);
  }

  const server = createServer((socket) => {
    const decoder = new FrameDecoder();
    let handshaked = false;

    function send(message: RpcMessage) {
      if (!socket.destroyed) socket.write(encodeFrame(message));
    }

    socket.on("data", (chunk) => {
      let messages: RpcMessage[];
      try {
        messages = decoder.push(chunk.toString("utf8"));
      } catch {
        socket.destroy();
        return;
      }

      for (const message of messages) {
        if (!handshaked) {
          if (message.type !== "hello") {
            socket.destroy();
            return;
          }
          const compatible = message.version === PROTOCOL_VERSION;
          send({ type: "hello_ack", version: PROTOCOL_VERSION, compatible });
          if (!compatible) {
            socket.end();
            return;
          }
          handshaked = true;
          clients.add(socket);
          setClientCount();
          continue;
        }

        if (message.type === "request") {
          const handler = options.handlers[message.method];
          if (!handler) {
            send({
              type: "response_error",
              id: message.id,
              error: { message: `unknown method: ${message.method}` },
            });
            continue;
          }
          handler(message.params)
            .then((result) => send({ type: "response", id: message.id, result }))
            .catch((error: unknown) => {
              const code = error && typeof error === "object" && "code" in error ? String(error.code) : undefined;
              const errMessage = error instanceof Error ? error.message : String(error);
              send({ type: "response_error", id: message.id, error: { message: errMessage, code } });
            });
        }
      }
    });

    socket.on("close", () => {
      clients.delete(socket);
      setClientCount();
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
    broadcast(event, payload) {
      const frame = encodeFrame({ type: "event", event, payload });
      for (const socket of clients) {
        if (!socket.destroyed) socket.write(frame);
      }
    },
    close() {
      for (const socket of clients) socket.destroy();
      return new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
