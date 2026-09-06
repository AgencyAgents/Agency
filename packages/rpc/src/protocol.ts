/**
 * Bumped whenever a wire-incompatible change lands (R12). A client refuses to
 * talk to a daemon on a different version rather than risk corrupting state;
 * see the hello handshake in server.ts/client.ts.
 *
 * v2 removed the HTTP `?token=` query-string bearer (use the Authorization
 * header or a minted scoped token from POST /auth/mint); every addition in
 * the A3 hardening round (subscribe/unsubscribe, ping/pong, hello.token /
 * hello_ack.authorized) was ADDITIVE, so v1 pairs interoperated and the
 * version stayed at 1 until this removal.
 */
export const PROTOCOL_VERSION = 2;

/**
 * Named RPC methods the daemon answers. The transport itself stays generic
 * (any method string dispatches through server.ts); this constant is the
 * shared spelling so clients and the daemon can't drift apart.
 */
export const PROVIDERS_LIST_METHOD = "providers_list";

export type RpcMessage =
  | { type: "hello"; version: number; token?: string }
  | { type: "hello_ack"; version: number; compatible: boolean; authorized?: boolean }
  | { type: "request"; id: string; method: string; params: unknown }
  | { type: "response"; id: string; result: unknown }
  | { type: "response_error"; id: string; error: { message: string; code?: string } }
  | { type: "event"; event: string; payload: unknown }
  /** Per-client event subscription (A3): narrow this connection's fanout. */
  | { type: "subscribe"; event?: string }
  | { type: "unsubscribe"; event?: string }
  /** Liveness probes: any inbound frame also refreshes client deadlines. */
  | { type: "ping" }
  | { type: "pong" };

/** Encodes one message as a newline-delimited JSON frame. */
export function encodeFrame(message: RpcMessage): string {
  return `${JSON.stringify(message)}\n`;
}

/** Default ceiling for one NDJSON frame, in UTF-16 code units (~bytes for
 *  ASCII; the wire is JSON text, so the approximation errs on the safe side). */
export const MAX_FRAME_BYTES = 32 * 1024 * 1024;

/**
 * Buffers arbitrary chunk boundaries and yields one parsed message per
 * complete line: the same "don't assume a frame arrives whole" discipline
 * as the SSE parser, just for NDJSON instead of text/event-stream.
 *
 * A frame larger than `maxFrameBytes` (a malformed or hostile peer) throws
 * instead of buffering without bound; callers treat that as fatal for the
 * connection (server destroys the socket, client fails its pending requests).
 */
export class FrameDecoder {
  private buffer = "";

  constructor(private readonly maxFrameBytes: number = MAX_FRAME_BYTES) {}

  /** Feed a chunk, get back every complete message it completed. */
  push(chunk: string): RpcMessage[] {
    this.buffer += chunk;
    const messages: RpcMessage[] = [];

    let newline = this.buffer.indexOf("\n");
    while (newline !== -1) {
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      if (line.length > this.maxFrameBytes) {
        throw new Error(`frame exceeds maximum size: ${line.length} > ${this.maxFrameBytes}`);
      }
      if (line.trim()) messages.push(JSON.parse(line) as RpcMessage);
      newline = this.buffer.indexOf("\n");
    }

    // Unterminated partial frame: bound the buffer so a peer that never
    // sends a newline can't grow it without limit.
    if (this.buffer.length > this.maxFrameBytes) {
      throw new Error(`frame exceeds maximum size: ${this.buffer.length} > ${this.maxFrameBytes}`);
    }

    return messages;
  }
}

/**
 * Subscription matching shared by both transports: an empty stream list
 * receives every event; otherwise a value matches an event by exact name,
 * and a bare turn id also matches its `turn.<id>` events (same shorthand
 * the HTTP gateway's `?stream=` has always had).
 */
export function matchesSubscription(streams: readonly string[], event: string): boolean {
  if (streams.length === 0) return true;
  return streams.some((stream) => stream === event || event === `turn.${stream}`);
}
