import { AgencyError, ErrorCode, type Message } from "@agency/schema";
import type { AgentRegistry } from "./registry.ts";
import { type OrchestraTodoItem, type OrchestraTodoStatus, OrchestraTodoStore } from "./todo.ts";

/**
 * A room is the persistent shared-work context for subagent delegation:
 * one shared goal, one lead, a member roster, and a shared todo list.
 * Inter-provider by construction — each member's provider/model/effort
 * lives on its AgentHandle; the room only tracks handles.
 */
export interface Room {
  id: string;
  goal: string;
  leaderHandle: string;
  memberHandles: string[];
  sharedTodos: OrchestraTodoItem[];
  createdAt: string;
}

export interface CreateRoomOptions {
  /** Explicit id (e.g. a session id). Defaults to `room-<n>`. */
  id?: string;
  /** Extra members beyond the leader. */
  memberHandles?: string[];
  /** Seed todos. Defaults to []. */
  initialTodos?: OrchestraTodoItem[];
}

export interface RoomOpResult {
  ok: boolean;
  reason?: string;
}

export interface BroadcastOptions {
  /** Attribution prefix recorded nowhere — informational for callers. */
  from?: string;
  /** Handles to skip (e.g. the sender's own mailbox). */
  exclude?: string[];
}

function fail(reason: string): RoomOpResult {
  return { ok: false, reason };
}

/**
 * Persistent store for rooms. Owns per-room shared-todo state (delegated
 * to OrchestraTodoStore, mirrored back onto Room.sharedTodos) and
 * mailbox broadcast via the bound AgentRegistry.
 */
export class RoomStore {
  private readonly rooms = new Map<string, Room>();
  private readonly todoStores = new Map<string, OrchestraTodoStore>();
  private readonly todoSeq = new Map<string, number>();
  private counter = 0;

  constructor(private readonly registry?: AgentRegistry) {}

  create(goal: string, leaderHandle: string, opts: CreateRoomOptions = {}): Room {
    if (goal.trim().length === 0) {
      throw new AgencyError(ErrorCode.TOOL_ERROR, "room goal must be non-empty", {
        source: "orchestra.room",
      });
    }
    if (leaderHandle.trim().length === 0) {
      throw new AgencyError(ErrorCode.TOOL_ERROR, "room leader handle must be non-empty", {
        source: "orchestra.room",
      });
    }
    const id = opts.id ?? `room-${++this.counter}`;
    if (this.rooms.has(id)) {
      throw new AgencyError(ErrorCode.TOOL_ERROR, `room already exists: ${id}`, {
        source: "orchestra.room",
        context: { roomId: id },
      });
    }
    const members = [leaderHandle];
    for (const h of opts.memberHandles ?? []) {
      if (!members.includes(h)) members.push(h);
    }
    const room: Room = {
      id,
      goal,
      leaderHandle,
      memberHandles: members,
      sharedTodos: [...(opts.initialTodos ?? [])],
      createdAt: new Date().toISOString(),
    };
    this.rooms.set(id, room);
    this.todoStores.set(
      id,
      new OrchestraTodoStore({
        initial: room.sharedTodos,
        persist: (todos) => {
          const current = this.rooms.get(id);
          if (current) current.sharedTodos = [...todos];
          return Promise.resolve();
        },
      }),
    );
    this.todoSeq.set(id, room.sharedTodos.length);
    return room;
  }

  get(id: string): Room | undefined {
    return this.rooms.get(id);
  }

  has(id: string): boolean {
    return this.rooms.has(id);
  }

  list(): Room[] {
    return [...this.rooms.values()];
  }

  delete(id: string): boolean {
    this.todoStores.delete(id);
    this.todoSeq.delete(id);
    return this.rooms.delete(id);
  }

  addMember(roomId: string, handle: string): RoomOpResult {
    const room = this.rooms.get(roomId);
    if (!room) return fail("room not found");
    if (handle.trim().length === 0) return fail("handle must be non-empty");
    if (room.memberHandles.includes(handle)) return fail(`already a member: ${handle}`);
    room.memberHandles.push(handle);
    return { ok: true };
  }

  removeMember(roomId: string, handle: string): RoomOpResult {
    const room = this.rooms.get(roomId);
    if (!room) return fail("room not found");
    if (handle === room.leaderHandle) return fail("cannot remove leader");
    const index = room.memberHandles.indexOf(handle);
    if (index < 0) return fail(`not a member: ${handle}`);
    room.memberHandles.splice(index, 1);
    return { ok: true };
  }

  appendTodo(roomId: string, content: string): OrchestraTodoItem {
    const room = this.requireRoom(roomId);
    if (content.trim().length === 0) {
      throw new AgencyError(ErrorCode.TOOL_ERROR, "todo content must be non-empty", {
        source: "orchestra.room",
        context: { roomId },
      });
    }
    const seq = (this.todoSeq.get(roomId) ?? 0) + 1;
    this.todoSeq.set(roomId, seq);
    const item: OrchestraTodoItem = { id: `${roomId}-todo-${seq}`, content, status: "pending" };
    const store = this.requireTodos(roomId);
    const next = [...store.list(), item];
    store.replace(next);
    room.sharedTodos = [...next];
    return item;
  }

  listTodos(roomId: string): OrchestraTodoItem[] {
    this.requireRoom(roomId);
    return this.requireTodos(roomId).list();
  }

  claimTodo(roomId: string, handle: string, id: string): RoomOpResult {
    const store = this.todoStores.get(roomId);
    if (!store) return fail("room not found");
    return store.claim(handle, id);
  }

  releaseTodo(roomId: string, handle: string, id: string): RoomOpResult {
    const store = this.todoStores.get(roomId);
    if (!store) return fail("room not found");
    return store.release(handle, id);
  }

  setTodoStatus(roomId: string, handle: string, id: string, status: OrchestraTodoStatus): RoomOpResult {
    const store = this.todoStores.get(roomId);
    if (!store) return fail("room not found");
    return store.setStatus(handle, id, status);
  }

  /**
   * Broadcast a message to every room member's mailbox. Returns the number
   * of mailboxes written. Isolation: only this room's memberHandles are
   * enqueued — members of other rooms never see the message.
   */
  appendMessage(roomId: string, msg: Message, opts: BroadcastOptions = {}): number {
    const room = this.requireRoom(roomId);
    if (!this.registry) {
      throw new AgencyError(ErrorCode.TOOL_ERROR, "no agent registry bound to RoomStore", {
        source: "orchestra.room",
        context: { roomId },
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

  private requireRoom(roomId: string): Room {
    const room = this.rooms.get(roomId);
    if (!room) {
      throw new AgencyError(ErrorCode.TOOL_ERROR, `room not found: ${roomId}`, {
        source: "orchestra.room",
        context: { roomId },
      });
    }
    return room;
  }

  private requireTodos(roomId: string): OrchestraTodoStore {
    const store = this.todoStores.get(roomId);
    if (!store) {
      throw new AgencyError(ErrorCode.INTERNAL, `todo store missing for room: ${roomId}`, {
        source: "orchestra.room",
        context: { roomId },
      });
    }
    return store;
  }
}
