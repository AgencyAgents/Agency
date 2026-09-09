import { AgencyError, ErrorCode, type Message } from "@agency/schema";
import type { AgentRegistry } from "./registry.ts";
import { type BoardItem, type BoardStatus, type BoardStorage, BoardStore } from "./todo.ts";

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
 *
 * With a `boardStorage` the per-team boards survive daemon restarts: every
 * board mutation writes a `<teamId>.board.jsonl` sidecar (best-effort, warns
 * on failure, never throws into the board path) and `restoreBoard` /
 * `preloadBoards` reload it on boot. Without storage the store is purely
 * in-memory, exactly as before.
 */
export class TeamStore {
  private readonly teams = new Map<string, Team>();
  private readonly todoStores = new Map<string, BoardStore>();
  private readonly todoSeq = new Map<string, number>();
  private counter = 0;
  private readonly boardStorage?: BoardStorage;
  private readonly onBoardWarn: (message: string) => void;

  constructor(
    private readonly registry?: AgentRegistry,
    opts?: { boardStorage?: BoardStorage; onBoardWarn?: (message: string) => void },
  ) {
    this.boardStorage = opts?.boardStorage;
    this.onBoardWarn = opts?.onBoardWarn ?? ((message) => console.warn(`[board] ${message}`));
  }

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
          this.queueBoardSave(id, [...todos]);
          return Promise.resolve();
        },
      }),
    );
    this.todoSeq.set(id, team.sharedTodos.length);
    if (team.sharedTodos.length > 0) this.queueBoardSave(id, [...team.sharedTodos]);
    return team;
  }

  /**
   Serializes sidecar writes per team so concurrent board mutations can
   never reorder on disk (last mutation wins). Best-effort: failures warn,
   never throw into the board path.
   */
  private readonly saveQueue = new Map<string, Promise<void>>();

  private queueBoardSave(teamId: string, snapshot: BoardItem[]): void {
    const storage = this.boardStorage;
    if (!storage) return;
    const warn = this.onBoardWarn;
    const prev = this.saveQueue.get(teamId) ?? Promise.resolve();
    let tail: Promise<void>;
    tail = prev.then(async () => {
      try {
        await storage.save(teamId, snapshot);
      } catch (error: unknown) {
        warn(
          `board sidecar save failed for ${teamId}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      if (this.saveQueue.get(teamId) === tail) this.saveQueue.delete(teamId);
    });
    this.saveQueue.set(teamId, tail);
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
    const storage = this.boardStorage;
    if (storage) {
      const warn = this.onBoardWarn;
      const prev = this.saveQueue.get(id) ?? Promise.resolve();
      let tail: Promise<void>;
      tail = prev.then(async () => {
        try {
          await storage.delete(id);
        } catch (error: unknown) {
          warn(
            `board sidecar delete failed for ${id}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        if (this.saveQueue.get(id) === tail) this.saveQueue.delete(id);
      });
      this.saveQueue.set(id, tail);
      void tail;
    }
    return this.teams.delete(id);
  }

  /**
   * Reloads one team's board from its sidecar (restart path): call after
   * `create` with the same id, or on a live team to re-read disk. The
   * sidecar wins over the seed; the todo sequence reseeds from the loaded
   * items so appended ids never collide. Returns false when no sidecar
   * exists (team keeps its current items).
   */
  async restoreBoard(teamId: string): Promise<boolean> {
    if (!this.boardStorage) return false;
    const team = this.teams.get(teamId);
    const store = this.todoStores.get(teamId);
    if (!team || !store) return false;
    const items = await this.boardStorage.load(teamId);
    if (items.length === 0 && !(await this.boardStorage.has(teamId))) return false;
    store.hydrate(items);
    team.sharedTodos = [...items];
    this.reseedSeq(teamId, items);
    return true;
  }

  /** Restart path for many teams: best-effort per team, never throws. */
  async preloadBoards(teamIds: string[]): Promise<void> {
    for (const id of teamIds) {
      try {
        await this.restoreBoard(id);
      } catch (error: unknown) {
        this.onBoardWarn(
          `board sidecar load failed for ${id}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }

  /** Awaits the sidecar write for one team (deterministic flush for tests / shutdown). */
  async flushBoard(teamId: string): Promise<void> {
    if (!this.boardStorage) return;
    await (this.saveQueue.get(teamId) ?? Promise.resolve());
    const store = this.todoStores.get(teamId);
    if (!store) return;
    await this.boardStorage.save(teamId, store.list());
  }

  private reseedSeq(teamId: string, items: readonly BoardItem[]): void {
    let max = 0;
    for (const item of items) {
      const match = /-todo-(\d+)$/.exec(item.id);
      if (match) max = Math.max(max, Number(match[1]));
    }
    this.todoSeq.set(teamId, Math.max(this.todoSeq.get(teamId) ?? 0, max, items.length));
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
