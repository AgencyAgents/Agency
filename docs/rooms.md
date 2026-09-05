# Rooms

A room is the persistent shared-work context for subagent delegation. It
provides one shared goal, one leader, a member roster, and a shared todo list
that every member sees and mutates. Rooms are inter-provider by construction:
each member's provider, model, and effort live on its AgentHandle; the room
only tracks handles.

## RoomStore

`packages/core/src/orchestra/room.ts` defines the `Room` interface and the
`RoomStore` class. A room has an `id`, a `goal` (non-empty string), a
`leaderHandle`, a `memberHandles` array, and a `sharedTodos` array. The store
owns per-room shared-todo state delegated to `OrchestraTodoStore` and mailbox
broadcast via the bound `AgentRegistry`.

Creating a room requires a non-empty goal and leader handle. Duplicate room ids
are rejected. Members are deduplicated: the leader is always first, extra
members are appended only if not already present. The store creates a
per-room `OrchestraTodoStore` with a persist callback that mirrors the todo
list back onto the room's `sharedTodos` field (room.ts lines 58-101).

## Shared todo store (kanban)

`packages/core/src/orchestra/todo.ts` implements `OrchestraTodoStore` with
four statuses: `pending`, `in_progress`, `completed`, `ready_for_review`.
Items carry a `claimedBy` field so agents do not step on each other.

- `claim(handle, id)`: sets `claimedBy` to the handle and promotes `pending`
  to `in_progress`. Returns an error if another handle already claimed it
  (todo.ts lines 31-39).
- `release(handle, id)`: clears `claimedBy` only when the caller is the
  current claimant. Returns an error otherwise (todo.ts lines 42-48).
- `setStatus(handle, id, status)`: a claimant cannot mark their own item
  `completed`; they must use `ready_for_review` instead. This enforces a
  review gate before final close. `completed` and `ready_for_review` both
  clear `claimedBy` (todo.ts lines 51-60).

The store accepts an optional `persist` callback. In the daemon, this writes
a `todo_state` entry to the session's JSONL file, so todos survive daemon
restarts and compaction (`packages/cli/src/daemon.ts` lines 670-688).

## Mailbox broadcast

`RoomStore.appendMessage` (room.ts lines 187-202) broadcasts a `Message` to
every room member's mailbox. It iterates the room's `memberHandles`, skips
excluded handles, and calls `AgentRegistry.enqueue` for each remaining
member. The method returns the count of mailboxes written. Isolation is
enforced: only this room's memberHandles are enqueued; members of other rooms
never see the message.

The `AgentRegistry` at `packages/core/src/orchestra/registry.ts` stores a
`mailbox: Message[]` per handle. `enqueue` pushes a message; `drain` returns
a copy and clears the array (registry.ts lines 50-63). The daemon's
`drainMailbox` callback (daemon.ts lines 1299-1311) drains both the
agent-level mailbox and the registry-level mailbox before each turn
iteration, injecting any queued messages into the conversation.

## ROOM_PROTOCOL

`packages/core/src/prompt/compose.ts` defines `ROOM_PROTOCOL` (line 42-43):

> "Room protocol: you share a session room with sibling agents. Check your
> mailbox at start, stay in your role lane, end with a lean <=500-word
> summary (what changed, files touched, verification)."

The `appendRoomProtocol` function (compose.ts lines 48-50) appends this
suffix to the role prompts for `leader`, `coder`, and `executor` -- the
three roles that coordinate or mutate state. Other roles (planner, explorer,
researcher, code-reviewer) do not get the room protocol because they are
read-only and do not share state with siblings.

The protocol is embedded in both the mechanics prompts (Anthropic family,
compose.ts lines 62-98) and the principle prompts (everything else, compose.ts
lines 126-163). Every dispatched agent with a coordinating role sees the room
protocol in its system prompt.

## Per-session isolation (SessionScope)

`packages/tools/src/session-scope.ts` defines `SessionScope`, the per-member
isolated slice of runtime state. The doc comment (lines 35-67) is explicit:

> "A session is a Room execution context: the room is the persistent shared
> abstraction -- shared goal, member roster, shared todos, mailbox broadcast
> -- while the SessionScope is the per-member isolated slice of runtime state
> that lets concurrent room members run without corrupting each other's
> mutable state."

Each scope owns its own:
- `bashState.cwd`: one cwd per session (session-scope.ts line 119).
- `TodoStore`: one todo list per session (line 121); the room-level shared
  list lives on the Room, this store is the member's working view.
- `ProcessManager`: one process table per session (line 120).
- `SnapshotStore` journal: per-instance in-memory journal (line 113-116);
  content-addressed blobs on disk are shared (hash-referenced), but the
  undo/journal ordering is per-session so two sessions' undo stacks never
  interleave.
- `ReadState`: per-session read journal (line 122).
- `ToolRegistry`/tools: per-session adapted set, capability-filtered per
  agent (lines 170-192).
- `McpManager`: one manager per session, keyed by sessionId in the daemon's
  sessionScopes map (session-scope.ts lines 324-333). Transports are never
  shared across sessions: each scope starts its own server processes and
  dispose() closes them.

The scope carries an optional `roomId` field (line 85) that links it back to
the owning room when the session runs as a member of a Room. Standalone
sessions leave this undefined.

## Dispatch depth limits

`packages/core/src/orchestra/dispatch.ts` creates the `dispatch` tool with
a `maxDepth` parameter defaulting to 3 (line 32). The handler checks two
conditions:

1. **Depth-0 child isolation**: subagents (taskDepth > 0) cannot dispatch.
   The check at line 87 returns an error: "nested dispatch blocked: subagents
   cannot dispatch".
2. **Hard depth cap**: when depth >= maxDepth, the handler returns "dispatch
   depth limit reached" (line 90-91).

The daemon spawns each child turn at `taskDepth + 1` (daemon.ts line 1296),
so nesting is bounded by `maxDepth` no matter how many levels dispatch
recurses. The same pattern applies to the `task` tool in
`packages/tools/src/builtins/task.ts` (lines 38-50): subagents (taskDepth > 0)
cannot spawn tasks, and the depth is capped at `maxDepth` (default 1).

## Parallel spawn with PromiseBarrier

`packages/core/src/orchestra/parallel.ts` implements run_in_background-like
semantics. Every specialist is spawned concurrently (no serial await), each
child receives only a lean slice of context (brief + one-line summary, never
a full history), and a single `PromiseBarrier` notifies exactly once when the
whole batch settles. One child failure never takes down its peers (per-slot
error capture, parallel.ts lines 117-154).

Lean-context caps are explicit constants (parallel.ts lines 11-14):

- `LEAN_BRIEF_MAX_CHARS = 2000`
- `LEAN_SUMMARY_MAX_CHARS = 500`
- `LEAN_PROMPT_MAX_CHARS = 200`
- `LEAN_RESULT_PREVIEW_CHARS = 80`

The daemon's dispatch handler (daemon.ts lines 1040-1060) creates a
`PromiseBarrier` for each batch, spawns all agents concurrently, and joins
on `barrier.wait()`. Results preserve input order via index slots.

## Budget enforcement

The daemon checks hard budget caps before spawning any peer
(daemon.ts lines 1000-1011). `checkOrchestraBudgets` (daemon.ts lines 392-411)
enforces per-agent and orchestra-wide dollar ceilings. A cost forecast
(daemon.ts lines 1012-1038) estimates a dollar range before any agent is
spawned, using brief length, each target agent's model pricing, and its
resolved effort level. When the high end exceeds a configurable threshold,
the dispatch must be approved through the same once/always/reject surface.
No approval surface means the dispatch fails closed.