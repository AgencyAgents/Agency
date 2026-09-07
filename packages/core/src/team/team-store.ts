import { AgencyError, ErrorCode, type Message } from "@agency/schema";
import type { AgentRegistry } from "./registry.ts";
import { type BoardItem, type BoardStatus, BoardStore } from "./todo.ts";

/**
 * A team is the persistent shared-work context for subagent delegation:
 * one shared goal, one lead, a member roster, and a shared todo list.
 * Inter-provider by construction (each member's provider/model/effort
 * lives on its AgentHandle; the team only tracks handles).
 */
export interface Team {
  id: string;
  goal: string;
  leaderHandle: string;
  memberHandles: string[];
  sharedTodos: BoardItem[];
  createdAt: string;
}

export interface CreateTeamOptions {
  /** Explicit id (e.g. a session id). Defaults to `team-<n>`. */
  id?: string;
  /** Extra members beyond the leader. */
  memberHandles?: string[];
  /** Seed todos. Defaults to []. */
  initialTodos?: BoardItem[];
}

export interface TeamOpResult {
  ok: boolean;
  reason?: string;
}

export interface BroadcastOptions {
  /** Attribution prefix recorded nowhere — informational for callers. */
  from?: string;
  /** Handles to skip (e.g. the sender's own mailbox). */
  exclude?: string[];
}

function fail(reason: string): TeamOpResult {
  return { ok: false, reason };
}

/**
 * Persistent store for teams. Owns per-team shared-todo state (delegated
 * to BoardStore, mirrored back onto Team.sharedTodos) and
 * mailbox broadcast via the bound AgentRegistry.
 */
export class TeamStore {
  private readonly teams = new Map<string, Team>();
  private readonly todoStores = new Map<string, BoardStore>();
  private readonly todoSeq = new Map<string, number>();
  private counter = 0;

  constructor(private readonly registry?: AgentRegistry) {}

  create(goal: string, leaderHandle: string, opts: CreateTeamOptions = {}): Team {
    if (goal.trim().length === 0) {
      throw new AgencyError(ErrorCode.TOOL_ERROR, "team goal must be non-empty", {
        source: "team.store",
      });
    }
    if (leaderHandle.trim().length === 0) {
      throw new AgencyError(ErrorCode.TOOL_ERROR, "team leader handle must be non-empty", {
        source: "team.store",
      });
    }
    const id = opts.id ?? `team-${++this.counter}`;
    if (this.teams.has(id)) {
      throw new AgencyError(ErrorCode.TOOL_ERROR, `team already exists: ${id}`, {
        source: "team.store",
        context: { teamId: id },
      });
    }
    const members = [leaderHandle];
    for (const h of opts.memberHandles ?? []) {
      if (!members.includes(h)) members.push(h);
    }
    const team: Team = {
      id,
      goal,
      leaderHandle,
      memberHandles: members,
      sharedTodos: [...(opts.initialTodos ?? [])],
      createdAt: new Date().toISOString(),
    };
    this.teams.set(id, team);
    this.todoStores.set(
      id,
      new BoardStore({
        initial: team.sharedTodos,
        persist: (todos) => {
          const current = this.teams.get(id);
          if (current) current.sharedTodos = [...todos];
          return Promise.resolve();
        },
      }),
    );
    this.todoSeq.set(id, team.sharedTodos.length);
    return team;
  }

  get(id: string): Team | undefined {
    return this.teams.get(id);
  }

  has(id: string): boolean {
    return this.teams.has(id);
  }

  list(): Team[] {
    return [...this.teams.values()];
  }

  delete(id: string): boolean {
    this.todoStores.delete(id);
    this.todoSeq.delete(id);
    return this.teams.delete(id);
  }

  addMember(teamId: string, handle: string): TeamOpResult {
    const team = this.teams.get(teamId);
    if (!team) return fail("team not found");
    if (handle.trim().length === 0) return fail("handle must be non-empty");
    if (team.memberHandles.includes(handle)) return fail(`already a member: ${handle}`);
    team.memberHandles.push(handle);
    return { ok: true };
  }

  removeMember(teamId: string, handle: string): TeamOpResult {
    const team = this.teams.get(teamId);
    if (!team) return fail("team not found");
    if (handle === team.leaderHandle) return fail("cannot remove leader");
    const index = team.memberHandles.indexOf(handle);
    if (index < 0) return fail(`not a member: ${handle}`);
    team.memberHandles.splice(index, 1);
    return { ok: true };
  }

  appendTodo(teamId: string, content: string): BoardItem {
    const team = this.requireTeam(teamId);
    if (content.trim().length === 0) {
      throw new AgencyError(ErrorCode.TOOL_ERROR, "todo content must be non-empty", {
        source: "team.store",
        context: { teamId },
      });
    }
    const seq = (this.todoSeq.get(teamId) ?? 0) + 1;
    this.todoSeq.set(teamId, seq);
    const item: BoardItem = { id: `${teamId}-todo-${seq}`, content, status: "pending" };
    const store = this.requireTodos(teamId);
    const next = [...store.list(), item];
    store.replace(next);
    team.sharedTodos = [...next];
    return item;
  }

  listTodos(teamId: string): BoardItem[] {
    this.requireTeam(teamId);
    return this.requireTodos(teamId).list();
  }

  claimTodo(teamId: string, handle: string, id: string): TeamOpResult {
    const store = this.todoStores.get(teamId);
    if (!store) return fail("team not found");
    return store.claim(handle, id);
  }

  releaseTodo(teamId: string, handle: string, id: string): TeamOpResult {
    const store = this.todoStores.get(teamId);
    if (!store) return fail("team not found");
    return store.release(handle, id);
  }

  setTodoStatus(teamId: string, handle: string, id: string, status: BoardStatus): TeamOpResult {
    const store = this.todoStores.get(teamId);
    if (!store) return fail("team not found");
    return store.setStatus(handle, id, status);
  }

  /**
   * Broadcast a message to every team member's mailbox. Returns the number
   * of mailboxes written. Isolation: only this team's memberHandles are
   * enqueued (members of other teams never see the message).
   */
  appendMessage(teamId: string, msg: Message, opts: BroadcastOptions = {}): number {
    const team = this.requireTeam(teamId);
    if (!this.registry) {
      throw new AgencyError(ErrorCode.TOOL_ERROR, "no agent registry bound to TeamStore", {
        source: "team.store",
        context: { teamId },
      });
    }
    const excluded = new Set(opts.exclude ?? []);
    let delivered = 0;
    for (const handle of team.memberHandles) {
      if (excluded.has(handle)) continue;
      if (this.registry.enqueue(handle, msg)) delivered++;
    }
    return delivered;
  }

  private requireTeam(teamId: string): Team {
    const team = this.teams.get(teamId);
    if (!team) {
      throw new AgencyError(ErrorCode.TOOL_ERROR, `team not found: ${teamId}`, {
        source: "team.store",
        context: { teamId },
      });
    }
    return team;
  }

  private requireTodos(teamId: string): BoardStore {
    const store = this.todoStores.get(teamId);
    if (!store) {
      throw new AgencyError(ErrorCode.INTERNAL, `todo store missing for team: ${teamId}`, {
        source: "team.store",
        context: { teamId },
      });
    }
    return store;
  }
}

/** One team per lead session: the team id derives from the lead session id. */
export function teamIdForLeadSession(leadSessionId: string): string {
  const clean = leadSessionId.replace(/[^A-Za-z0-9-_]+/g, "-").replace(/^-+|-+$/g, "");
  return `team-${clean.length > 0 ? clean : "session"}`;
}

export function ensureTeamForLeadSession(
  store: TeamStore,
  leadSessionId: string,
  goal: string,
  leaderHandle: string,
): Team {
  const id = teamIdForLeadSession(leadSessionId);
  const existing = store.get(id);
  if (existing) return existing;
  return store.create(goal, leaderHandle, { id });
}
