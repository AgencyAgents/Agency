import type { Message } from "@agency/schema";

export interface AgentHandle {
  handle: string;
  role: string;
  provider: string;
  model: string;
  effort: string;
  sessionId: string;
  mailbox: Message[];
  capabilities?: string[];
}

export function parseHandles(text: string): string[] {
  const re = /@([a-z][a-z0-9-]*)/g;
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const h = m[1]!;
    if (!out.includes(h)) out.push(h);
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
    const msgs = [...agent.mailbox];
    agent.mailbox.length = 0;
    return msgs;
  }
}
