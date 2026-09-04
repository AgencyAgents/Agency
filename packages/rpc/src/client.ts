import { randomUUID } from "node:crypto";
import { createConnection, type Socket } from "node:net";
import { PendingRequestManager } from "@agency/net";
import { encodeFrame, FrameDecoder, PROTOCOL_VERSION, type RpcMessage } from "./protocol.ts";
import { FrameWriter } from "./writer.ts";

export interface DaemonClient {
  call(method: string, params: unknown, timeoutMs?: number): Promise<unknown>;
  on(event: string, handler: (payload: unknown) => void): () => void;
  /**
   * Narrows this client's event stream server-side (A3): only matching
   * events are sent over this connection. Omit the event to return to
   * wildcard (every event). A bare turn id also matches `turn.<id>`.
   */
  subscribe(event?: string): void;
  /** Removes one subscription; omit the event to receive nothing. */
  unsubscribe(event?: string): void;
  close(): Promise<void>;
}

export interface ConnectToDaemonOptions {
  /** Per-instance token (from the instance file) checked on hello. */
  token?: string;
  /**
   * Idle window that bounds every call: a pending request fails only after
   * this long with NO inbound traffic, because every frame from the daemon
   * (turn deltas, heartbeats, pongs) re-arms the deadline. A long turn that
   * is visibly making progress therefore never rejects client-side while
   * the daemon keeps burning tokens. Default 30_000.
   */
  heartbeatMs?: number;
  /** Auto-reconnect (with capped backoff, resubscribing) after an
   *  established connection drops. Default true. */
  reconnect?: boolean;
}

export const DEFAULT_CALL_TIMEOUT_MS = 30_000;
const PING_INTERVAL_MS = 10_000;
const RECONNECT_MAX_DELAY_MS = 5_000;
const MAX_OUTBOX_FRAMES = 256;

/**
 * Connects to a running daemon and performs the version handshake before
 * returning. A client that can't confirm compatibility never gets a
 * usable connection (R12: refuse rather than risk corrupting state).
 *
 * Resilience (A3): the connection is heartbeat-probed while idle, malformed
 * inbound frames fail the connection instead of crashing the process, and a
 * dropped connection reconnects with backoff — re-sending subscriptions and
 * flushing calls made while disconnected. The first connect is deliberately
 * one-shot: liveness probes (ensureDaemon) rely on fast failure.
 */
export async function connectToDaemon(
  port: number,
  host = "127.0.0.1",
  options: ConnectToDaemonOptions = {},
): Promise<DaemonClient> {
  const heartbeatMs = options.heartbeatMs ?? DEFAULT_CALL_TIMEOUT_MS;
  const pending = new PendingRequestManager<string>({ makeId: () => randomUUID() });
  const deadlines = new Map<string, number>();
  const listeners = new Map<string, Set<(payload: unknown) => void>>();
  const subscriptions = new Set<string>();
  let wildcard = true;
  const outbox: string[] = [];

  let socket: Socket | undefined;
  let writer: FrameWriter | undefined;
  let decoder: FrameDecoder | undefined;
  let lastInbound = Date.now();
  let closedByClient = false;
  let authRejected = false;
  let reconnectAttempts = 0;
  let pingTimer: ReturnType<typeof setInterval> | undefined;

  function clearPing() {
    if (pingTimer !== undefined) {
      clearInterval(pingTimer);
      pingTimer = undefined;
    }
  }

  function armPing() {
    clearPing();
    pingTimer = setInterval(
      () => {
        if (!socket || socket.destroyed) return;
        if (Date.now() - lastInbound > heartbeatMs * 3) {
          // No sign of life for three windows: deafen no longer, reconnect.
          socket.destroy();
          return;
        }
        writer?.write(encodeFrame({ type: "ping" }));
      },
      Math.min(heartbeatMs / 3, PING_INTERVAL_MS),
    );
    pingTimer.unref?.();
  }

  function refreshDeadlines() {
    for (const [id, ms] of deadlines) pending.refresh(id, ms);
  }

  function handleMessage(message: RpcMessage) {
    lastInbound = Date.now();
    if (message.type === "response" || message.type === "response_error") {
      if (message.type === "response") pending.resolve(message.id, message.result);
      else pending.reject(message.id, new Error(message.error.message));
    } else if (message.type === "event") {
      for (const listener of listeners.get(message.event) ?? []) listener(message.payload);
    }
  }

  function onData(chunk: Buffer) {
    let messages: RpcMessage[] | undefined;
    try {
      messages = decoder?.push(chunk.toString("utf8"));
    } catch {
      // Malformed frame: never crash on parse (the server side already
      // guards this); fail the connection instead.
      socket?.destroy();
      return;
    }
    for (const message of messages ?? []) handleMessage(message);
    refreshDeadlines();
  }

  function sendFrame(message: RpcMessage) {
    const frame = encodeFrame(message);
    if (socket && !socket.destroyed && writer?.write(frame)) return;
    if (outbox.length >= MAX_OUTBOX_FRAMES) {
      pending.failAll(new Error("connection to daemon closed"));
      outbox.length = 0;
    }
    outbox.push(frame);
  }

  function flushOutbox() {
    while (outbox.length > 0 && socket && !socket.destroyed) {
      const frame = outbox.shift();
      if (frame === undefined) break;
      if (!writer?.write(frame)) break; // backpressure or teardown; FrameWriter queues
    }
  }

  function attach(sock: Socket) {
    socket = sock;
    writer = new FrameWriter(sock, { onOverflow: () => sock.destroy() });
    lastInbound = Date.now();
    sock.on("data", onData);
    sock.on("close", onClose);
    sock.on("error", () => sock.destroy());
    armPing();
  }

  function onClose() {
    clearPing();
    writer?.reset();
    pending.failAll(new Error("connection to daemon closed"));
    deadlines.clear();
    socket = undefined;
    writer = undefined;
    decoder = undefined;
    if (closedByClient) return;
    scheduleReconnect();
  }

  function scheduleReconnect() {
    if (closedByClient || authRejected || options.reconnect === false) return;
    const delay = Math.min(100 * 2 ** reconnectAttempts, RECONNECT_MAX_DELAY_MS);
    reconnectAttempts += 1;
    const timer = setTimeout(() => {
      if (closedByClient) return;
      connectOnce()
        .then((sock) => {
          reconnectAttempts = 0;
          attach(sock);
          if (!wildcard) {
            for (const event of subscriptions) sendFrame({ type: "subscribe", event });
          }
          flushOutbox();
        })
        .catch(() => scheduleReconnect());
    }, delay);
    timer.unref?.();
  }

  /** One connection attempt: TCP connect + version/token handshake. The
   *  decoder created here is the steady-state one, so frames arriving in the
   *  same chunk as the ack are consumed once, never double-fed. */
  async function connectOnce(): Promise<Socket> {
    const sock = createConnection(port, host);
    await new Promise<void>((resolve, reject) => {
      sock.once("connect", resolve);
      sock.once("error", reject);
    });

    const dec = new FrameDecoder();
    decoder = dec;

    sock.write(encodeFrame({ type: "hello", version: PROTOCOL_VERSION, token: options.token }));
    const ack = await new Promise<Extract<RpcMessage, { type: "hello_ack" }>>((resolve, reject) => {
      const onData = (chunk: Buffer) => {
        let messages: RpcMessage[];
        try {
          messages = dec.push(chunk.toString("utf8"));
        } catch {
          sock.destroy();
          reject(new Error("daemon sent a malformed handshake frame"));
          return;
        }
        for (const message of messages) {
          if (message.type === "hello_ack") {
            sock.off("data", onData);
            resolve(message);
            return;
          }
        }
      };
      sock.on("data", onData);
      sock.once("error", reject);
      sock.once("close", () => reject(new Error("connection closed during handshake")));
    });

    if (!ack.compatible) {
      sock.destroy();
      throw new Error(
        `daemon protocol version ${ack.version} is incompatible with this client's version ${PROTOCOL_VERSION}`,
      );
    }
    if (ack.authorized === false) {
      authRejected = true; // permanent: retrying with the same token is futile
      sock.destroy();
      throw new Error("daemon rejected the connection: missing or invalid auth token");
    }
    return sock;
  }

  const first = await connectOnce();
  attach(first);

  return {
    call(method, params, timeoutMs = DEFAULT_CALL_TIMEOUT_MS) {
      if (closedByClient) return Promise.reject(new Error("client is closed"));
      const { id, promise } = pending.register(
        timeoutMs,
        () => new Error(`RPC call "${method}" timed out after ${timeoutMs}ms without daemon activity`),
      );
      deadlines.set(id, timeoutMs);
      sendFrame({ type: "request", id, method, params });
      return promise.finally(() => deadlines.delete(id));
    },

    on(event, handler) {
      const set = listeners.get(event) ?? new Set();
      set.add(handler);
      listeners.set(event, set);
      return () => set.delete(handler);
    },

    subscribe(event) {
      if (event === undefined) {
        wildcard = true;
        subscriptions.clear();
      } else {
        wildcard = false;
        subscriptions.add(event);
      }
      sendFrame(event === undefined ? { type: "subscribe" } : { type: "subscribe", event });
    },

    unsubscribe(event) {
      if (event === undefined) {
        wildcard = false;
        subscriptions.clear();
      } else {
        subscriptions.delete(event);
      }
      sendFrame(event === undefined ? { type: "unsubscribe" } : { type: "unsubscribe", event });
    },

    close() {
      return new Promise<void>((resolve) => {
        closedByClient = true;
        clearPing();
        writer?.reset();
        if (!socket || socket.destroyed) {
          resolve();
          return;
        }
        socket.end(() => resolve());
      });
    },
  };
}
