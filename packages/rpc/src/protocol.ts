/**
 * Bumped whenever a wire-incompatible change lands (R12). A client refuses to
 * talk to a daemon on a different version rather than risk corrupting state —
 * see the hello handshake in server.ts/client.ts.
 */
export const PROTOCOL_VERSION = 1;

export type RpcMessage =
  | { type: "hello"; version: number }
  | { type: "hello_ack"; version: number; compatible: boolean }
  | { type: "request"; id: string; method: string; params: unknown }
  | { type: "response"; id: string; result: unknown }
  | { type: "response_error"; id: string; error: { message: string; code?: string } }
  | { type: "event"; event: string; payload: unknown };

/** Encodes one message as a newline-delimited JSON frame. */
export function encodeFrame(message: RpcMessage): string {
  return `${JSON.stringify(message)}\n`;
}

/**
 * Buffers arbitrary chunk boundaries and yields one parsed message per
 * complete line — the same "don't assume a frame arrives whole" discipline
 * as the SSE parser, just for NDJSON instead of text/event-stream.
 */
export class FrameDecoder {
  private buffer = "";

  /** Feed a chunk, get back every complete message it completed. */
  push(chunk: string): RpcMessage[] {
    this.buffer += chunk;
    const messages: RpcMessage[] = [];

    let newline: number;
    while ((newline = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      if (line.trim()) messages.push(JSON.parse(line) as RpcMessage);
    }

    return messages;
  }
}
