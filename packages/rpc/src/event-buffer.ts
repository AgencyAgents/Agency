/**
 * Bounded per-key ring buffer behind resumable SSE. Each published event
 * takes the next monotonic id; keys (usually sessions) evict oldest-first
 * past the bound, so one chatty session never starves another's tail.
 */
export interface RingEntry {
  id: number;
  event: string;
  payload: unknown;
}

export class EventRing {
  private next = 0;
  private readonly rings = new Map<string, RingEntry[]>();

  constructor(private readonly bound: number = 256) {}

  /** Newest id issued, 0 when nothing was published yet. */
  get newest(): number {
    return this.next;
  }

  /** Oldest retained id, 0 when the buffer is empty. */
  oldest(): number {
    let best = 0;
    for (const ring of this.rings.values()) {
      const first = ring[0]?.id ?? 0;
      if (first > 0 && (best === 0 || first < best)) best = first;
    }
    return best;
  }

  /** Publish one event, returning its monotonic id. */
  append(event: string, payload: unknown, key = "global"): number {
    this.next += 1;
    const entry: RingEntry = { id: this.next, event, payload };
    const ring = this.rings.get(key) ?? [];
    ring.push(entry);
    while (ring.length > this.bound) ring.shift();
    this.rings.set(key, ring);
    return this.next;
  }

  /**
   * Entries after `lastId` matching `match`, oldest-first across keys.
   * Empty when the client is current, or when `lastId` predates the
   * retained tail (the caller then falls back to the state frame).
   */
  since(lastId: number, match: (event: string) => boolean): RingEntry[] {
    if (lastId >= this.next) return [];
    const out: RingEntry[] = [];
    for (const ring of this.rings.values()) {
      for (const entry of ring) {
        if (entry.id > lastId && match(entry.event)) out.push(entry);
      }
    }
    out.sort((a, b) => a.id - b.id);
    return out;
  }

  /** True when `lastId` names a retained (or future) id, so gap-tailing is exact. */
  covers(lastId: number): boolean {
    if (lastId >= this.next) return true;
    const oldest = this.oldest();
    return oldest !== 0 && lastId >= oldest - 1;
  }
}

/** Formats one resumable SSE frame: id first so EventSource tracks it. */
export function sseFrame(id: number, event: string, payload: unknown): string {
  return `id: ${id}\nevent: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
}
