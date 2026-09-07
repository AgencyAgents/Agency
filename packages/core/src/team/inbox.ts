import type { BoardEvent } from "./todo.ts";

export type InboxKind = "ask" | "answer" | "notify" | "handoff" | "blocked" | "delegate";

export const INBOX_KINDS: readonly InboxKind[] = [
  "ask",
  "answer",
  "notify",
  "handoff",
  "blocked",
  "delegate",
];

export interface InboxMessage {
  id: string;
  kind: InboxKind;
  from: string;
  to?: string;
  text: string;
  at: string;
}

export interface InboxSend {
  kind: InboxKind;
  from: string;
  to?: string;
  text: string;
}

// Typed inbox with per-agent budgets and lead-only broadcast.
// Broadcast (no `to`) is the lead's move; peers name one recipient.
export class InboxStore {
  private readonly boxes = new Map<string, InboxMessage[]>();
  private readonly counts = new Map<string, number>();
  private seq = 0;

  constructor(private readonly perAgentBudget = 50) {}

  send(msg: InboxSend): { ok: true; message: InboxMessage } | { ok: false; reason: string } {
    if (!INBOX_KINDS.includes(msg.kind)) return { ok: false, reason: `unknown kind: ${msg.kind}` };
    if (msg.from.trim().length === 0) return { ok: false, reason: "sender is required" };
    if (msg.text.trim().length === 0) return { ok: false, reason: "text is required" };
    if (msg.kind === "ask" && (msg.to === undefined || msg.to.length === 0)) {
      return { ok: false, reason: "ask names one recipient" };
    }
    if (msg.to === undefined && msg.from !== "lead") {
      return { ok: false, reason: "broadcast is lead-only" };
    }
    const used = this.counts.get(msg.from) ?? 0;
    if (used >= this.perAgentBudget) {
      return { ok: false, reason: `${msg.from} exceeded the inbox budget of ${this.perAgentBudget}` };
    }
    this.seq += 1;
    const full: InboxMessage = {
      id: `m-${this.seq}`,
      kind: msg.kind,
      from: msg.from,
      ...(msg.to === undefined ? {} : { to: msg.to }),
      text: msg.text,
      at: new Date().toISOString(),
    };
    this.counts.set(msg.from, used + 1);
    if (msg.to === undefined) {
      for (const box of this.boxes.values()) box.push(full);
      this.broadcastCache = [...(this.broadcastCache ?? []), full];
    } else {
      const box = this.boxes.get(msg.to) ?? [];
      box.push(full);
      this.boxes.set(msg.to, box);
    }
    return { ok: true, message: full };
  }

  private broadcastCache: InboxMessage[] | undefined;

  // Pulls this agent's tail: directed mail plus broadcasts since join.
  // The box drains on read so the tail stays the only copy in flight.
  take(handle: string): InboxMessage[] {
    const box = this.boxes.get(handle) ?? [];
    this.boxes.set(handle, []);
    return [...box];
  }

  sentBy(handle: string): number {
    return this.counts.get(handle) ?? 0;
  }
}

export interface ChannelPost {
  seq: number;
  by: string;
  text: string;
  at: string;
}

// The channel is pull-only: append freely, read from a cursor,
// never injected into a prompt unasked.
export class ChannelStore {
  private readonly posts: ChannelPost[] = [];
  private seq = 0;

  post(by: string, text: string): ChannelPost {
    this.seq += 1;
    const post: ChannelPost = { seq: this.seq, by, text, at: new Date().toISOString() };
    this.posts.push(post);
    return post;
  }

  read(since = 0, limit = 100): { posts: ChannelPost[]; cursor: number } {
    const posts = this.posts.filter((p) => p.seq > since).slice(0, Math.max(1, limit));
    const cursor = posts.length > 0 ? (posts[posts.length - 1]?.seq ?? since) : since;
    return { posts, cursor };
  }

  size(): number {
    return this.posts.length;
  }
}

export const DIGEST_LINE_BUDGET = 30;

export interface DigestInput {
  events: readonly BoardEvent[];
  posts: readonly ChannelPost[];
  decisions: readonly string[];
  lastSeenEvent: number;
  lastSeenPost: number;
  lineBudget?: number;
  summarizeFreeText?: (texts: string[]) => string;
}

// What changed since this agent's last turn, capped at a fixed
// line budget. Board events render deterministically; only free
// text falls back to the cheap model summarizer when provided.
export function buildDigest(input: DigestInput): {
  lines: string[];
  cursor: { event: number; post: number };
} {
  const budget = input.lineBudget ?? DIGEST_LINE_BUDGET;
  const lines: string[] = [];
  let eventCursor = input.lastSeenEvent;
  for (const event of input.events) {
    if (event.seq <= input.lastSeenEvent) continue;
    lines.push(`board ${event.itemId} ${event.move} by @${event.by}`);
    eventCursor = Math.max(eventCursor, event.seq);
  }
  let postCursor = input.lastSeenPost;
  const fresh = input.posts.filter((p) => p.seq > input.lastSeenPost);
  if (fresh.length > 0) {
    if (input.summarizeFreeText) {
      const summary = input.summarizeFreeText(fresh.map((p) => `@${p.by}: ${p.text}`));
      if (summary.trim().length > 0) lines.push(`channel: ${summary.trim()}`);
    } else {
      for (const post of fresh.slice(0, Math.max(0, budget - lines.length))) {
        const text = post.text.length > 160 ? `${post.text.slice(0, 160)}...` : post.text;
        lines.push(`channel @${post.by}: ${text}`);
      }
    }
    postCursor = fresh[fresh.length - 1]?.seq ?? postCursor;
  }
  for (const decision of input.decisions) {
    if (lines.length >= budget) break;
    lines.push(decision);
  }
  return { lines: lines.slice(0, budget), cursor: { event: eventCursor, post: postCursor } };
}
