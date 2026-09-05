# Harness comparison

This document compares Agency against OpenCode, Oh-My-Opencode (OMO), and
Cline across the dimensions that matter for multi-agent workflows. Every
technical claim cites the file path where the relevant code lives.

## Provider compatibility

Agency supports Anthropic, OpenAI, Google, and any OpenAI-compatible endpoint
(self-hosted, gateways, corporate proxies). The adapter resolution lives in
`packages/cli/src/daemon.ts` lines 268-301: a config-defined provider speaks
its declared family's wire format (defaulting to openai-compatible), a builtin
family id falls back to its native adapter, and a catalog provider with a known
API base URL gets the openai-compatible adapter pointed there. The family
presets in `packages/providers/src/presets.ts` wire each adapter to its cache
strategy and streaming behavior.

OpenCode uses Effect-based services with Vercel AI SDK providers. It supports
Anthropic, OpenAI, and Google but has no openai-compatible adapter for
corporate gateways or self-hosted endpoints. Cline uses a Gateway provider
registry with Anthropic, OpenAI, Google, and OpenAI-compatible support, but
keys live in `.env` or plaintext config with no keychain integration.

## Credential rotation

Agency's key resolution chain lives in `packages/providers/src/auth/resolve.ts`
and follows a strict 4-layer precedence: flag -> env -> keychain -> config.
The keychain backend at `packages/providers/src/auth/keychain.ts` selects the
native OS store at runtime: Windows Credential Manager (`windows.ts`), macOS
Keychain Services (`macos.ts`), Linux secret-tool (`linux.ts`), or an encrypted
file fallback (`file-fallback.ts`).

OAuth with PKCE lives in `packages/providers/src/auth/oauth.ts`. It supports
Anthropic, OpenAI, Google, and GitHub Copilot with auto-refresh and dedup
(concurrent refresh requests share one in-flight promise). The `resolveApiKey`
function calls `refreshOAuthToken` before every use, so tokens are always fresh
when they reach the provider adapter.

OpenCode stores keys in `.env` or config files. No keychain. No OAuth. Cline
stores keys in `.env` or plaintext config. No OAuth. No keychain. No token
rotation.

## System prompts

Agency composes system prompts in `packages/core/src/prompt/compose.ts` with
cache-prefix ordering. The stable prefix (identity + role + instructions + tool
descriptions) is byte-identical across turns; only the dynamic tail (environment
block with date, per-turn reminders) changes. The comment at line 195 is
explicit: "this string is the provider's cache-breakpoint prefix, so any
incidental reordering between turns would silently kill the cache hit rate."

Per-role prompts are selected by model family via `resolveFamilyPrompt`
(compose.ts lines 182-185). Claude-family models get mechanics-driven prompts
(explicit checklists, numbered steps). Everything else gets principle-driven
prompts (concise principles, decision criteria). Seven roles are defined:
leader, planner, plan-reviewer, coder, executor, explorer, researcher,
code-reviewer.

System reminders (`formatSystemReminders` at compose.ts lines 261-265) are
appended per-turn but only when active. The `withSystemReminders` function
(compose.ts lines 270-281) returns the composed prompt unchanged when there
are no reminders. Turns with no active reminders keep the exact same system
prompt string, maximizing cache hits.

OpenCode uses a single system prompt per session with no per-role routing.
Cline uses a system prompt with plan/act mode tags but no per-role
differentiation. Neither orders prompt sections for cache stability.

## Compaction and token efficiency

Agency's compaction lives in `packages/core/src/sessions/compaction.ts`. It
uses a proactive ratio (default 80% of context window, line 61-63) and a
reactive compact-and-retry path for context overflow. `planCompaction`
(compaction.ts lines 76-87) keeps the most recent `keepLastN` messages (default
4) out of the summary and preserves every `todo_state` entry regardless of
position: todos are the run's task list and must never be lost to compaction.
The `compact` function (compaction.ts lines 101-150) summarizes the older
portion via a caller-provided `summarize` function, writes a
`compaction_summary` entry, then re-appends the preserved tail onto the new
summary as a fresh tip. The old chain is untouched in the file, still visible
to `/tree`, just no longer part of the live branch.

Lean context for subagents is enforced in `packages/core/src/orchestra/parallel.ts`
(lines 11-14): briefs capped at 2000 chars, summaries at 500 chars, prompt
excerpts at 200 chars, result previews at 80 chars. Tool output truncation in
`packages/core/src/truncate.ts` caps every result at 50,000 UTF-8 bytes or
2,000 lines, whichever is hit first.

OpenCode uses prune-based compaction: it removes older messages from the
session array. No proactive ratio, no todo preservation, no summary folding.
Cline uses two-stage compaction with a 90% trigger threshold and 70% target,
preserving 20K tokens. Neither uses lean-context caps for subagents.

## Subagent model

Agency's subagent architecture has four layers:

1. **AgentRegistry** (`packages/core/src/orchestra/registry.ts`): handle-based
   registry with role, provider, model, effort, mailbox, and capabilities per
   agent.
2. **Dispatch tool** (`packages/core/src/orchestra/dispatch.ts`): depth control
   (default maxDepth 3, subagents cannot dispatch), approval gate, cost
   forecast, render hints.
3. **Parallel spawn** (`packages/core/src/orchestra/parallel.ts`): concurrent
   spawn with PromiseBarrier, per-slot error capture, lean context.
4. **Room** (`packages/core/src/orchestra/room.ts`): shared goal, roster,
   shared todos, mailbox broadcast.

Each subagent runs in its own `SessionScope` (`packages/tools/src/session-scope.ts`)
with isolated bashState, process table, snapshot journal, read state, tool
registry, and MCP manager. The daemon creates one scope per session id and
keys them in the `sessionScopes` map (`packages/cli/src/daemon.ts` line 749).

OpenCode uses a `task` tool that spawns ephemeral worker child sessions with
isolated context (`packages/tools/src/builtins/task.ts`). The worker receives
a prompt and returns text. There is no registry, no mailbox, no parallel spawn,
no shared todo list, no room state. Subagents cannot dispatch or spawn tasks
(task.ts lines 38-50). The model is single-agent with tool-based delegation.

Oh-My-Opencode is an OpenCode plugin layer that adds a Sisyphus orchestrator
with Oracle, Librarian, and Explore specialists, category routing, and
Metis/Momus plan consultants. It routes tasks by category but does not provide
shared room state, mailbox broadcast, or a shared todo list that agents mutate
concurrently. Each subagent is still an isolated task sub-session with no
shared goal or roster.

Cline uses a single-runtime model with hooks for tool approval. There is no
multi-agent architecture. The 3-layer tool approval (hooks/policy/user
callback) gates tool calls but does not coordinate multiple agents.

## Plan flow

Agency's plan flow lives in `packages/tools/src/builtins/plan.ts`. It uses
hash-chained plan approvals:

1. A planner writes a plan file with GFM task list items (`.opencode/plans/`
   or legacy `.agency/plans/`).
2. `plan_exit` presents the plan as a Yes/No question. A Yes writes a
   `PlanApprovalRecord` with the plan path, content SHA-256 hash, approver,
   and timestamp (plan.ts lines 93-112).
3. `execute_plan` reads the approval record, verifies the content hash matches
   the current file (plan.ts lines 311-326), and converts unchecked steps into
   todos. Editing the plan after approval invalidates the hash, and execution
   refuses a plan nobody actually approved in its current form.
4. Unresolved comments block approval (plan.ts lines 97-101): a plan with
   unresolved comments cannot be approved into execution.

The plan agent's permissions (plan.ts lines 176-188) are read-only everywhere
except plan files: write/edit deny everything but `.opencode/plans/**` and
`.agency/plans/**`.

OpenCode uses a plan/act mode with session reminders. Plans are written to
`.opencode/plans/` but there is no hash-chain verification: the plan file can
be edited after approval without detection. Oh-My-Opencode adds Metis/Momus
plan consultants that review plans before execution, but the approval is
prompt-based rather than hash-anchored. Cline uses plan/act mode tags in the
system prompt with no hash-verified approval record.

## Why rooms are better

A room provides three things that OpenCode task sub-sessions, Cline single-
runtime hooks, and OMO category routing do not:

1. **Shared goal**: every agent in the room sees the same `goal` string
   (`packages/core/src/orchestra/room.ts` line 13). OpenCode task sub-sessions
   each get their own prompt with no shared objective. Cline has no subagent
   concept. OMO category routing dispatches to specialists but each receives
   an independent prompt with no reference to a team goal.

2. **Shared todos**: the `OrchestraTodoStore` (`packages/core/src/orchestra/todo.ts`)
   is a single mutable list that every room member reads and writes. Items have
   `claimedBy` so agents do not duplicate work. OpenCode's `TodoStore` in
   `packages/tools/src/builtins/todo.ts` is per-session: each subagent has its
   own todo list and cannot see what sibling agents are working on. OMO has no
   shared todo list across category-routed specialists.

3. **Mailbox broadcast**: `RoomStore.appendMessage` (room.ts lines 187-202)
   delivers a message to every room member's mailbox. The `drainMailbox`
   callback in the daemon (daemon.ts lines 1299-1311) injects queued messages
   before each turn iteration. OpenCode task sub-sessions have no mailbox
   mechanism: one subagent cannot send a message to another. Cline has no
   inter-agent communication. OMO specialists run in isolated sessions with
   no mailbox.

The combination means a leader can dispatch five specialists, each sees the
same goal and todo list, each can claim work items, and the leader can
broadcast mid-task corrections to all members at once. No other harness
provides this coordination model.