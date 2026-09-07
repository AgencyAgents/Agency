export type ActivityNodeKind = "agent" | "task";

export interface ActivityGraphItem {
  id: string;
  content: string;
  status: string;
  claimedBy?: string;
  filedBy?: string;
  declineReason?: string;
  escalateQuestion?: string;
  failureNote?: string;
  costUsd?: number;
  tokens?: number;
}

export interface ActivityGraphEvent {
  seq: number;
  itemId: string;
  by: string;
  move: string;
}

export interface ActivityAgentInfo {
  handle: string;
  role?: string;
}

export interface ActivityNode {
  id: string;
  kind: ActivityNodeKind;
  label: string;
  state: string;
  blockedReason?: string;
  costUsd: number;
  tokens?: number;
}

export interface ActivityEdge {
  from: string;
  to: string;
  itemId: string;
  reason: string;
}

export interface ActivityGraph {
  nodes: ActivityNode[];
  edges: ActivityEdge[];
  totalUsd: number;
}

// Why structural inputs: the graph rebuilds from board state
// alone, so any store exposing items plus events can feed it.
export function boardBlockedReason(item: ActivityGraphItem): string | undefined {
  if (item.status === "needs-user") return item.escalateQuestion ?? "waiting on user";
  if (item.failureNote !== undefined) return item.failureNote;
  if (item.declineReason !== undefined) return item.declineReason;
  return undefined;
}

// The live delegation DAG: agents plus tasks as nodes,
// delegate events as edges, per-node cost from board attribution.
export function buildActivityGraph(args: {
  items: readonly ActivityGraphItem[];
  events: readonly ActivityGraphEvent[];
  agents: readonly ActivityAgentInfo[];
  agentState: (handle: string) => string;
  agentCost: (handle: string) => number;
}): ActivityGraph {
  const nodes: ActivityNode[] = [];
  let totalUsd = 0;
  for (const agent of args.agents) {
    const costUsd = args.agentCost(agent.handle);
    totalUsd += costUsd;
    nodes.push({
      id: `agent:${agent.handle}`,
      kind: "agent",
      label: agent.role ?? agent.handle,
      state: args.agentState(agent.handle),
      costUsd,
    });
  }
  for (const item of args.items) {
    nodes.push({
      id: `task:${item.id}`,
      kind: "task",
      label: item.content,
      state: item.status,
      ...(boardBlockedReason(item) === undefined ? {} : { blockedReason: boardBlockedReason(item) }),
      costUsd: item.costUsd ?? 0,
      ...(item.tokens === undefined ? {} : { tokens: item.tokens }),
    });
  }
  const edges: ActivityEdge[] = [];
  for (const event of args.events) {
    if (!event.move.startsWith("delegate:")) continue;
    const to = event.move.slice("delegate:".length);
    if (to.length === 0) continue;
    edges.push({ from: event.by, to, itemId: event.itemId, reason: "delegate" });
  }
  return { nodes, edges, totalUsd };
}
