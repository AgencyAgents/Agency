import type { Message } from "@agency/schema";

export interface AgentHandle {
  handle: string;
  role: string;
  provider: string;
  /** Optional: resolved at runtime from the provider catalog or global config.model. */
  model?: string;
  effort: string;
  sessionId: string;
  mailbox: Message[];
  capabilities?: string[];
  /** Role prompt from the agent file body; falls back to the built-in line. */
  systemPrompt?: string;
  tools?: string[];
  pathScope?: string[];
}

export function parseHandles(text: string): string[] {
  const re = /@([a-z][a-z0-9-]*)/g;
  const out: string[] = [];
  for (let m = re.exec(text); m !== null; m = re.exec(text)) {
    const h = m[1];
    if (h !== undefined && !out.includes(h)) out.push(h);
  }
  return out;
}

export class AgentRegistry {
  private agents = new Map<string, AgentHandle>();

  register(agent: AgentHandle): void {
    this.agents.set(agent.handle, agent);
  }

  get(handle: string): AgentHandle | undefined {
    return this.agents.get(handle);
  }

  list(): AgentHandle[] {
    return [...this.agents.values()];
  }

  has(handle: string): boolean {
    return this.agents.has(handle);
  }

  leader(leaderHandle?: string): AgentHandle | undefined {
    if (leaderHandle) return this.agents.get(leaderHandle);
    const first = this.agents.values().next().value as AgentHandle | undefined;
    return first;
  }

  enqueue(to: string, msg: Message): boolean {
    const agent = this.agents.get(to);
    if (!agent) return false;
    agent.mailbox.push(msg);
    return true;
  }

  drain(handle: string): Message[] {
    const agent = this.agents.get(handle);
    if (!agent) return [];
    // Copy + clear: callers get a snapshot, the mailbox is empty after.
    const msgs = [...agent.mailbox];
    agent.mailbox.length = 0;
    return msgs;
  }

  /** Alias for drain: handle-keyed mailbox, returns copy and clears. */
  drainMailbox(handle: string): Message[] {
    return this.drain(handle);
  }

  /** Non-destructive peek at a handle's queued messages (copy, no clear). */
  peek(handle: string): Message[] {
    return [...(this.agents.get(handle)?.mailbox ?? [])];
  }
}
