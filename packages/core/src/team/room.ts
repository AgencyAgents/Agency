import { AgencyError, ErrorCode, type Message } from "@agency/schema";
import type { AgentRegistry } from "./registry.ts";
import { type BoardItem, type BoardStatus, BoardStore } from "./todo.ts";

/**
 * A room is the persistent shared-work context for subagent delegation:
 * one shared goal, one lead, a member roster, and a shared todo list.
 * Inter-provider by construction — each member's provider/model/effort
 * lives on its AgentHandle; the room only tracks handles.
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
  /** Explicit id (e.g. a session id). Defaults to `room-<n>`. */
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
 * Persistent store for teams. Owns per-room shared-todo state (delegated
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
        source: "team.room",
      });
    }
    if (leaderHandle.trim().length === 0) {
      throw new AgencyError(ErrorCode.TOOL_ERROR, "team leader handle must be non-empty", {
        source: "team.room",
      });
    }
    const id = opts.id ?? `team-${++this.counter}`;
    if (this.teams.has(id)) {
      throw new AgencyError(ErrorCode.TOOL_ERROR, `team already exists: ${id}`, {
        source: "team.room",
        context: { teamId: id },
      });
    }
    const members = [leaderHandle];
    for (const h of opts.memberHandles ?? []) {
      if (!members.includes(h)) members.push(h);
    }
    const room: Team = {
      id,
      goal,
      leaderHandle,
      memberHandles: members,
      sharedTodos: [...(opts.initialTodos ?? [])],
      createdAt: new Date().toISOString(),
    };
    this.teams.set(id, room);
    this.todoStores.set(
      id,
      new BoardStore({
        initial: room.sharedTodos,
        persist: (todos) => {
          const current = this.teams.get(id);
          if (current) current.sharedTodos = [...todos];
          return Promise.resolve();
        },
      }),
    );
    this.todoSeq.set(id, room.sharedTodos.length);
    return room;
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
    const room = this.teams.get(teamId);
    if (!room) return fail("team not found");
    if (handle.trim().length === 0) return fail("handle must be non-empty");
    if (room.memberHandles.includes(handle)) return fail(`already a member: ${handle}`);
    room.memberHandles.push(handle);
    return { ok: true };
  }

  removeMember(teamId: string, handle: string): TeamOpResult {
    const room = this.teams.get(teamId);
    if (!room) return fail("team not found");
    if (handle === room.leaderHandle) return fail("cannot remove leader");
    const index = room.memberHandles.indexOf(handle);
    if (index < 0) return fail(`not a member: ${handle}`);
    room.memberHandles.splice(index, 1);
    return { ok: true };
  }

  appendTodo(teamId: string, content: string): BoardItem {
    const room = this.requireTeam(teamId);
    if (content.trim().length === 0) {
      throw new AgencyError(ErrorCode.TOOL_ERROR, "todo content must be non-empty", {
        source: "team.room",
        context: { teamId },
      });
    }
    const seq = (this.todoSeq.get(teamId) ?? 0) + 1;
    this.todoSeq.set(teamId, seq);
    const item: BoardItem = { id: `${teamId}-todo-${seq}`, content, status: "pending" };
    const store = this.requireTodos(teamId);
    const next = [...store.list(), item];
    store.replace(next);
    room.sharedTodos = [...next];
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
   * Broadcast a message to every room member's mailbox. Returns the number
   * of mailboxes written. Isolation: only this room's memberHandles are
   * enqueued — members of other teams never see the message.
   */
  appendMessage(teamId: string, msg: Message, opts: BroadcastOptions = {}): number {
    const room = this.requireTeam(teamId);
    if (!this.registry) {
      throw new AgencyError(ErrorCode.TOOL_ERROR, "no agent registry bound to TeamStore", {
        source: "team.room",
        context: { teamId },
      });
    }
    const excluded = new Set(opts.exclude ?? []);
    let delivered = 0;
    for (const handle of room.memberHandles) {
      if (excluded.has(handle)) continue;
      if (this.registry.enqueue(handle, msg)) delivered++;
    }
    return delivered;
  }

  private requireTeam(teamId: string): Team {
    const room = this.teams.get(teamId);
    if (!room) {
      throw new AgencyError(ErrorCode.TOOL_ERROR, `team not found: ${teamId}`, {
        source: "team.room",
        context: { teamId },
      });
    }
    return room;
  }

  private requireTodos(teamId: string): BoardStore {
    const store = this.todoStores.get(teamId);
    if (!store) {
      throw new AgencyError(ErrorCode.INTERNAL, `todo store missing for team: ${teamId}`, {
        source: "team.room",
        context: { teamId },
      });
    }
    return store;
  }
}
