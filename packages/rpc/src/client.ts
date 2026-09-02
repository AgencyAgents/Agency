import { randomUUID } from "node:crypto";
import { createConnection, type Socket } from "node:net";
import { PendingRequestManager } from "@agency/net";
import { encodeFrame, FrameDecoder, PROTOCOL_VERSION, type RpcMessage } from "./protocol.ts";

export interface DaemonClient {
  call(method: string, params: unknown, timeoutMs?: number): Promise<unknown>;
  on(event: string, handler: (payload: unknown) => void): () => void;
  close(): Promise<void>;
}

/**
 * Connects to a running daemon and performs the version handshake before
 * returning. A client that can't confirm compatibility never gets a
 * usable connection (R12: refuse rather than risk corrupting state).
 */
export async function connectToDaemon(port: number, host = "127.0.0.1"): Promise<DaemonClient> {
  const socket: Socket = createConnection(port, host);
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });

  const decoder = new FrameDecoder();

  function send(message: RpcMessage) {
    socket.write(encodeFrame(message));
  }

  // Handshake first, with its own one-shot listener. The steady-state
  // dispatcher below only attaches once we know we're talking to a
  // compatible daemon, so there's never more than one consumer of `decoder`
  // at a time (it's stateful; two simultaneous consumers would double-feed it).
  send({ type: "hello", version: PROTOCOL_VERSION });
  const ack = await new Promise<Extract<RpcMessage, { type: "hello_ack" }>>((resolve, reject) => {
    const onData = (chunk: Buffer) => {
      for (const message of decoder.push(chunk.toString("utf8"))) {
        if (message.type === "hello_ack") {
          socket.off("data", onData);
          resolve(message);
          return;
        }
      }
    };
    socket.on("data", onData);
    socket.once("error", reject);
  });

  if (!ack.compatible) {
    socket.destroy();
    throw new Error(
      `daemon protocol version ${ack.version} is incompatible with this client's version ${PROTOCOL_VERSION}`,
    );
  }

  const pending = new PendingRequestManager<string>({ makeId: () => randomUUID() });
  const listeners = new Map<string, Set<(payload: unknown) => void>>();

  socket.on("data", (chunk) => {
    for (const message of decoder.push(chunk.toString("utf8"))) {
      if (message.type === "response" || message.type === "response_error") {
        if (message.type === "response") pending.resolve(message.id, message.result);
        else pending.reject(message.id, new Error(message.error.message));
      } else if (message.type === "event") {
        for (const listener of listeners.get(message.event) ?? []) listener(message.payload);
      }
    }
  });

  socket.on("close", () => {
    pending.failAll(new Error("connection to daemon closed"));
  });

  return {
    call(method, params, timeoutMs = 30_000) {
      const { id, promise } = pending.register(
        timeoutMs,
        () => new Error(`RPC call "${method}" timed out after ${timeoutMs}ms`),
      );
      send({ type: "request", id, method, params });
      return promise;
    },

    on(event, handler) {
      const set = listeners.get(event) ?? new Set();
      set.add(handler);
      listeners.set(event, set);
      return () => set.delete(handler);
    },

    close() {
      return new Promise<void>((resolve) => {
        socket.end(() => resolve());
      });
    },
  };
}
