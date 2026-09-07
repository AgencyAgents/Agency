import type { Socket } from "node:net";

export interface FrameWriterOptions {
  /** Queue beyond this and the peer isn't consuming: the socket is destroyed
   *  rather than buffering without bound. Default 8 MiB. */
  maxQueuedBytes?: number;
  /** Called right before the socket is destroyed on overflow (observability). */
  onOverflow?: () => void;
}

/**
 * The sending half of a frame socket, with backpressure actually handled:
 * `socket.write` returning false parks subsequent frames in a bounded queue
 * that flushes on the socket's `drain` event. `send`/`broadcast` that ignore
 * the write return can buffer megabytes in the kernel for a stalled peer;
 * this turns that into an explicit, capped queue — and a destroyed socket
 * (which on the server side also cancels that client's in-flight turns)
 * when the cap is hit.
 */
export class FrameWriter {
  private queue: string[] = [];
  private queuedBytes = 0;
  private waitingDrain = false;
  private readonly maxQueuedBytes: number;

  constructor(
    private readonly socket: Socket,
    options: FrameWriterOptions = {},
  ) {
    this.maxQueuedBytes = options.maxQueuedBytes ?? 8 * 1024 * 1024;
    this.onOverflow = options.onOverflow;
  }

  private readonly onOverflow: (() => void) | undefined;

  /**
   * Hands one frame to the socket, or queues it while the socket drains.
   * Returns false only when the frame was dropped (socket destroyed, or the
   * overflow cap was hit and the socket torn down).
   */
  write(frame: string): boolean {
    if (this.socket.destroyed) return false;
    if (this.waitingDrain) return this.enqueue(frame);

    if (this.socket.write(frame)) return true;
    // Kernel buffer full: park everything after this frame until drain.
    this.waitingDrain = true;
    this.socket.once("drain", this.handleDrain);
    return true;
  }

  private enqueue(frame: string): boolean {
    this.queuedBytes += frame.length;
    if (this.queuedBytes > this.maxQueuedBytes) {
      this.onOverflow?.();
      this.socket.destroy();
      return false;
    }
    this.queue.push(frame);
    return true;
  }

  private readonly handleDrain = () => {
    this.waitingDrain = false;
    while (this.queue.length > 0) {
      const frame = this.queue.shift();
      if (frame === undefined) break;
      this.queuedBytes -= frame.length;
      if (this.socket.destroyed) return;
      if (!this.socket.write(frame)) {
        this.waitingDrain = true;
        this.socket.once("drain", this.handleDrain);
        return;
      }
    }
  };

  /** Drops queued frames and the drain listener (transport died or is being
   *  discarded). Queued frames are intentionally NOT replayed: a request
   *  already handed to a socket may have reached the daemon, and replaying
   *  RPCs like run_turn could double-burn tokens. */
  reset(): void {
    this.socket.off("drain", this.handleDrain);
    this.queue = [];
    this.queuedBytes = 0;
    this.waitingDrain = false;
  }
}
