# Why Agency

A headless coding harness that treats provider flexibility, credential safety,
subagent orchestration, permission enforcement, and token efficiency as first-
class architecture, not bolt-ons. This document compares Agency against Cline,
OpenCode, Claude Code, and Codex across the dimensions that matter for
engineering teams who need autonomous multi-agent workflows without
sacrificing control.

## Comparison table

| Dimension | Agency | Cline | OpenCode | Claude Code | Codex |
|---|---|---|---|---|---|
| **Provider support** | Anthropic, OpenAI, Google, any OpenAI-compatible endpoint (self-hosted, gateways, corporate proxies) | Anthropic, OpenAI, Google, OpenAI-compatible | Anthropic, OpenAI, Google | Anthropic only | Anthropic, OpenAI (limited) |
| **Key storage** | OS keychain (Windows Credential Manager, macOS Keychain, Linux secret-tool) + encrypted file fallback | .env file or plaintext config | .env file or plaintext config | First-party OAuth only | First-party auth only |
| **Key resolution chain** | flag -> env -> keychain -> config (4-layer, explicit precedence) | env -> config (2-layer) | env -> config (2-layer) | N/A (first-party) | N/A (first-party) |
| **OAuth support** | PKCE flow with auto-refresh, dedup, per-provider config | None | None | Built-in (Anthropic only) | Built-in (limited) |
| **Subagent delegation** | AgentRegistry + dispatch tool + mailbox pattern + depth control + parallel barrier | Tool-based (limited) | Tool-based (limited) | N/A | N/A |
| **Cross-provider fallback** | Category routing with 3+ provider fallback chains per task type | None | None | N/A | N/A |
| **Permission enforcement** | PolicyEngine (allow/ask/deny), ApprovalManager (session grants), trust gate, sandbox boundary, capability model, cost forecast | Basic allow/deny | allow/ask/deny triad | N/A | N/A |
| **Token efficiency** | Cache-prefix ordering, lean briefs/summaries, system reminders (no-padding), 50KB/2000-line truncation, per-role model routing, effort mapping | Basic truncation | Basic truncation | Provider-managed | Provider-managed |
| **Workspace trust** | File-backed trust store with inheritance, required for mutating tools | None | Basic | N/A | N/A |
| **Secret redaction** | Single chokepoint Redactor, known key patterns + registered secrets | None | Basic | N/A | N/A |
| **Session model** | Append-only JSONL trees with fork/clone/resume, crash recovery, proactive+reactive compaction | Linear JSON | Linear JSON | First-party managed | First-party managed |
| **Edit safety** | Hash-anchored search/replace, daemon-owned content-addressed snapshots, undo/redo RPC | Basic search/replace | Hash-anchored search/replace | First-party managed | First-party managed |
| **MCP support** | stdio + HTTP with headers/timeoutMs, parallel start, mcp_status RPC, mcp_server_down reminder | stdio MCP | stdio MCP | Built-in | Built-in |
| **LSP integration** | Diagnostics after write/edit for edit verification | None | None | N/A | N/A |
| **Headless mode** | Daemon, RPC, HTTP+SSE gateway, CLI | CLI only | CLI only | CLI only | CLI only |
| **Platform support** | Windows, macOS, Linux (equal standing) | Windows, macOS, Linux | Windows, macOS, Linux | macOS, Linux | macOS, Linux |

## Architecture overview

Agency is organized as a monorepo of packages, each with a single
responsibility:

| Package | Responsibility | Key files |
|---|---|---|
| `packages/providers` | Provider adapters, auth, model catalog, effort mapping, scheduling, streaming | `src/auth/resolve.ts`, `src/auth/keychain.ts`, `src/auth/oauth.ts`, `src/adapters/*.ts`, `src/effort-mapping.ts`, `src/presets.ts`, `src/scheduler.ts`, `src/stream-recovery.ts` |
| `packages/guard` | Permission policy, approvals, trust, sandbox, capabilities, redaction, cost forecast | `src/policy.ts`, `src/approval.ts`, `src/trust.ts`, `src/sandbox.ts`, `src/capabilities.ts`, `src/redactor.ts`, `src/forecast.ts` |
| `packages/core` | Agent loop, orchestra (registry, dispatch, parallel, category routing, todos), prompt composition, tool execution, truncation, tracing | `src/loop.ts`, `src/orchestra/registry.ts`, `src/orchestra/dispatch.ts`, `src/orchestra/parallel.ts`, `src/orchestra/category-routing.ts`, `src/prompt/compose.ts`, `src/truncate.ts` |
| `packages/schema` | Message types, error codes, content blocks | `src/message.ts`, `src/error.ts` |
| `packages/net` | HTTP client with retry, SSE parsing | `src/http.ts`, `src/sse.ts` |

The data flow for a single turn:

1. The daemon receives a prompt (CLI, RPC, or HTTP+SSE gateway).
2. `composeSystemPrompt` builds the system prompt with cache-prefix ordering.
3. `runTurn` in `loop.ts` drives the agent loop: send messages to the
   provider, collect streamed responses, execute tool calls.
4. Before each tool call, `PermissionsGate.check` evaluates the policy
   (allow/ask/deny), checks the trust gate, and routes `ask` through the
   approval callback.
5. Tool results are truncated at 50KB/2000 lines and fed back to the model.
6. The loop repeats until a non-tool_use stop reason, budget breach, or
   iteration cap.
7. If the model calls `dispatch`, the orchestra spawns peer agents with
   lean context, parallel execution, and cross-provider fallback.

## BYOK and provider flexibility

Agency treats "bring your own key" as a first-class resolution chain, not an
afterthought. The entire chain lives in `packages/providers/src/auth/resolve.ts`
and follows a strict precedence:

```
flag (--api-key) -> env (AGENCY_ANTHROPIC_API_KEY) -> keychain (OS native) -> config (file)
```

Each layer is independently configurable. A CI pipeline can set an env var. A
local developer can use `agency auth login anthropic` to store in the OS
keychain. A self-hosted gateway behind a corporate proxy can pass `--provider
openai-compatible --api-endpoint https://gateway.corp.com/v1` and the
OpenAI-compatible adapter at `packages/providers/src/adapters/openai-compatible.ts`
handles the rest.

### Provider adapters

Each provider family gets a dedicated adapter implementing the same
`ProviderAdapter` interface (`packages/providers/src/types.ts`):

- **Anthropic** (`adapters/anthropic.ts`): explicit cache breakpoints, no
  parallel tool call deltas.
- **OpenAI** (`adapters/openai.ts`): automatic server-side caching, parallel
  tool call deltas by index.
- **Google** (`adapters/google.ts`): automatic caching, no parallel deltas.
- **OpenAI-compatible** (`adapters/openai-compatible.ts`): any endpoint
  (Ollama, OpenRouter, Groq, vLLM, corporate gateways) via config.

The family presets in `packages/providers/src/presets.ts` wire each adapter to
its cache strategy and streaming behavior. Adding a new provider family means
writing one adapter file and one preset entry.

### Provider catalog and model registry

`packages/providers/src/registry.ts` maintains a catalog of known models with
their capabilities, pricing, and effort mappings. The `catalog-cache.ts` module
keeps a local snapshot so the system works offline. `packages/providers/src/
catalog/models-dev.ts` ships a hand-maintained set of model entries for
development and fallback.

The `defaultModelIDs` function in the catalog returns the best default model
for each provider family, used by category routing when a pinned model is not
available in the local catalog. This means category routes degrade gracefully
when a model ID changes or is not yet indexed.

### Effort mapping per provider

`packages/providers/src/effort-mapping.ts` maps Agency's 7 effort levels
(off, minimal, low, medium, high, xhigh, max) to each provider's native
thinking budget. The mapping is per-provider because Anthropic uses token
budgets, OpenAI uses string levels, Google uses token budgets with different
scales, and DeepSeek/GLM use their own ranges. The `clampEffortForModel`
function never rejects -- it always returns a valid effort level the model
can use, clamped to the nearest supported value.

### Stream recovery

`packages/providers/src/stream-recovery.ts` implements mid-stream recovery
for provider API failures. When a stream drops mid-response, the recovery
layer retries from the last known good state instead of restarting the entire
turn. This is wired into the loop via `withMidStreamRecovery` in
`packages/core/src/loop.ts`.

### Scheduler with retry

`packages/providers/src/scheduler.ts` implements a per-provider rate limiter
and retry scheduler. It handles 429 (rate limit), 500 (server error), and
network-level failures with exponential backoff. The `retry-after.ts` module
parses `Retry-After` headers from provider responses. The scheduler is
injected into `runTurn` so every model call goes through the same retry
policy.

### OAuth with PKCE

Agency ships a full OAuth 2.0 authorization code flow with PKCE
(`packages/providers/src/auth/oauth.ts`). It supports Anthropic, OpenAI,
Google, and GitHub Copilot out of the box, with per-provider client IDs and
scopes. The flow:

1. Starts a local HTTP server on a random port.
2. Opens the provider's authorize URL with PKCE challenge.
3. Exchanges the callback code for tokens.
4. Stores the token in the OS keychain.
5. Auto-refreshes before expiry with dedup (concurrent refresh requests
   share one in-flight promise).

Self-hosted gateways can override `baseUrl` to derive custom authorize/token
endpoints. The `resolveApiKey` function in `resolve.ts` checks OAuth tokens
before plain API keys, so OAuth is the default path when configured.

### What this means vs the alternatives

- **Cline**: keys in `.env` or plaintext config. No OAuth. No keychain. No
  OpenAI-compatible adapter for corporate gateways.
- **OpenCode**: keys in `.env` or config. No keychain. No OAuth.
- **Claude Code**: Anthropic-only. First-party OAuth, but locked to one
  provider. No BYOK for other providers.
- **Codex**: Anthropic and limited OpenAI. First-party auth only. No keychain.

Agency is the only harness where you can store an Anthropic key in the macOS
Keychain, set an OpenAI key as an env var in CI, and route through a self-
hosted vLLM endpoint -- all in the same config, all through the same
resolution chain.

## Credential management and rotation

### OS-native keychain per platform

`packages/providers/src/auth/keychain.ts` selects the native backend at
runtime:

- **Windows** (`windows.ts`): Windows Credential Manager via `wincred`.
- **macOS** (`macos.ts`): Keychain Services via `security` CLI.
- **Linux** (`linux.ts`): `secret-tool` (libsecret).
- **Fallback** (`file-fallback.ts`): encrypted file in the data directory when
  no native backend is available (headless Linux, containers).

The fallback is transparent: `createKeychain` tries the native backend first,
and if `isAvailable()` returns false, it drops to the file backend without
any config change.

### OAuth token rotation

The `refreshOAuthToken` function in `oauth.ts` handles the full lifecycle:

- Checks expiry with a 60-second buffer.
- Uses a per-provider in-flight map to dedup concurrent refreshes.
- Stores the refreshed token back to the keychain.
- Falls back to the existing access token if refresh fails (stale but
  possibly still valid).

The `resolveApiKey` function calls `refreshOAuthToken` before every use, so
tokens are always fresh when they reach the provider adapter.

### Secret redaction

`packages/guard/src/redactor.ts` implements a single chokepoint for secret
scrubbing. Every log line, telemetry payload, and crash bundle passes through
`Redactor.redact()`. It handles:

- Registered secrets (loaded from keychain, env, or flag).
- Known key patterns (Anthropic `sk-ant-...`, OpenAI `sk-...`, Google
  `AIzaSy...`).

The `registerSecret` method is called the moment a secret is loaded, before
it is ever used. This means no code path between loading and redacting can
leak the raw value.

### What this means vs the alternatives

- **Cline**: keys in `.env` files. No rotation. No redaction.
- **OpenCode**: keys in config files. No rotation. Basic redaction.
- **Claude Code**: first-party OAuth only. Rotation handled by Anthropic.
  No multi-provider credential management.
- **Codex**: first-party auth. No keychain integration.

Agency is the only harness that stores keys in the OS credential store,
rotates OAuth tokens with dedup, and redacts secrets at a single chokepoint
before they reach any output path.

## Rooms and orchestra: subagent delegation and shared work

Agency's orchestra is the only architecture among these tools that treats
multi-agent delegation as a core primitive, not a prompt hack.

### AgentRegistry

`packages/core/src/orchestra/registry.ts` implements a handle-based registry
where each agent has:

- A unique `handle` (e.g. `@planner`, `@coder`).
- A `role` (leader, planner, coder, executor, explorer, researcher,
  code-reviewer).
- A `provider` and optional `model`.
- An `effort` level.
- A `mailbox` for message passing.
- Optional `capabilities`.

Agents register once and are looked up by handle. The registry supports
`enqueue` (push a message to an agent's mailbox) and `drain` (pop all
messages atomically).

### Dispatch tool

`packages/core/src/orchestra/dispatch.ts` creates the `dispatch` tool that
the leader model calls to spawn peer agents. Key design decisions:

- **Depth control**: nested dispatch is blocked at depth > 0. Subagents
  cannot dispatch their own subagents. The `maxDepth` parameter (default 3)
  bounds the nesting tree.
- **Approval gate**: costly dispatches route through the same
  once/always/reject approval surface as dangerous commands.
- **Cost forecast**: `packages/guard/src/forecast.ts` estimates a dollar
  range before any agent is spawned, using the brief length, each target
  agent's model pricing, and its resolved effort level. The forecast is
  shown in the approval prompt so the user sees "$2.40-$8.50 for 3 agents"
  before approving.
- **Render hints**: the tool's `renderCall` and `renderResult` produce
  compact one-line summaries for the UI.

### Parallel spawn with PromiseBarrier

`packages/core/src/orchestra/parallel.ts` implements `run_in_background`-like
semantics:

- Every specialist is spawned concurrently (no serial await).
- Each child receives only a lean slice of context (brief + one-line summary,
  never a full history).
- A single `PromiseBarrier` notifies exactly once when the whole batch
  settles.
- One child failure never takes down its peers (per-slot error capture).

The lean-context caps are explicit constants:

```typescript
export const LEAN_BRIEF_MAX_CHARS = 2000;
export const LEAN_SUMMARY_MAX_CHARS = 500;
export const LEAN_PROMPT_MAX_CHARS = 200;
```

### Category routing with cross-provider fallback

`packages/core/src/orchestra/category-routing.ts` maps task categories to
optimized provider+model+temperature combinations, with cross-provider
fallback chains:

| Category | Primary | Fallback 1 | Fallback 2 |
|---|---|---|---|
| visual-engineering | anthropic/claude-sonnet-5 | openai/gpt-5.2 | google/gemini-3-pro |
| ultrabrain | anthropic/claude-opus-5 | openai/gpt-5.2 | google/gemini-3-pro |
| deep | openai/gpt-5.2 | anthropic/claude-sonnet-5 | google/gemini-3-pro |
| quick | deepseek/deepseek-v4 | glm/glm-7 | openai/gpt-5.2 |
| unspecified | anthropic/claude-sonnet-5 | openai/gpt-5.2 | google/gemini-3-pro |

Every chain spans at least 3 distinct provider families. The
`runWithCategoryFallback` function tries each hop in order until one
succeeds, then rejects with an aggregate error naming every attempted
provider/model pair when the chain is exhausted. A single provider outage
never strands a delegate turn.

### Shared todo store

`packages/core/src/orchestra/todo.ts` implements a shared todo list that
orchestra agents use to coordinate work. Items have status (pending,
in_progress, completed, ready_for_review) and a `claimedBy` field so agents
don't step on each other. The store supports optional persistence.

### What this means vs the alternatives

- **Cline**: no multi-agent architecture. Single model, single turn.
- **OpenCode**: tool-based delegation only. No registry, no mailboxes, no
  parallel spawn, no category routing, no cross-provider fallback.
- **Claude Code**: single-agent. No subagent concept.
- **Codex**: single-agent. No subagent concept.

Agency is the only harness where a leader model can dispatch 5 specialist
agents in parallel, each on a different provider if the primary is down,
with cost estimates shown before any token is spent.

## Enforcement and approvals

Agency's permission system is the most granular among these tools. It lives
in `packages/guard/src/` and covers every tool call.

### PolicyEngine

`packages/guard/src/policy.ts` implements a first-match-wins rule evaluator.
Rules are assembled from the permissions config and support:

- **Tool-level**: `{"bash": "deny"}` blocks all bash calls.
- **Path-level**: `{"write": {"src/**": "allow", "*.env": "deny"}}` scopes
  by glob.
- **Command-level**: `{"bash": {"git *": "allow", "rm *": "ask"}}` scopes
  by arity-normalized command prefix.

The `COMMAND_ARITY` table defines how many words to keep when normalizing
(`git` -> 2 keeps `git checkout` from `git checkout main`). This lets exact
patterns match regardless of branch names, file paths, or flags.

### ApprovalManager

`packages/guard/src/approval.ts` manages session-scoped approval state:

- **once**: approves this single occurrence.
- **always**: records a session-scoped grant and retroactively resolves
  matching pending asks (two terminals asking for the same command queue
  one prompt, not two).
- **reject**: refuses.

Grants persist to disk per-session so "always" survives daemon restart.
The `rejectTurn` method cleans up pending asks on turn abort, and
`rejectAll` clears everything on daemon shutdown.

### Trust gate

`packages/guard/src/trust.ts` implements a file-backed trust store. A
directory is untrusted until explicitly confirmed. Trust inherits downward:
trusting a parent directory covers every subdirectory. Mutating and
executing tools (anything above `safe` risk tier) refuse to run in an
untrusted workspace. Read-only tools still work, so an untrusted workspace
produces a usable read-only session instead of a dead one.

### Sandbox boundary

`packages/guard/src/sandbox.ts` bounds where tool execution is allowed to
touch. It resolves paths through `realpath` to catch symlink escapes, and
supports an `external_directory` gate for paths outside the workspace root.
The `checkCommand` method supports allow/deny regex lists.

### Capability model

`packages/guard/src/capabilities.ts` defines per-caller capabilities:

- **tools**: which tools the caller may invoke.
- **pathScopes**: which directories the caller may read or write.
- **network**: which hosts the caller's tools may reach.

Three built-in levels: `NO_CAPABILITIES` (nothing), `FULL_CAPABILITIES`
(everything), and caller-specific subsets. The `requireTool`,
`requirePathScope`, and `requireNetwork` functions throw typed
`PERMISSION_DENIED` errors.

### Cost forecast

`packages/guard/src/forecast.ts` estimates a dollar range for dispatch
operations before any agent is spawned. Uses effort-level output
multipliers (off=1x, max=5x) and per-model pricing. When the high end
exceeds a configurable threshold, the dispatch must be approved through
the same once/always/reject surface. No approval surface available means
the dispatch fails closed.

### Doom-loop detection

`packages/core/src/loop.ts` implements opt-in doom-loop detection for
dispatched peers. It detects identical tool+input 3x consecutively and
halts the turn. The solo room keeps its existing semantics (capped by
`maxToolIterations`, not by input-identity heuristics).

### What this means vs the alternatives

- **Cline**: basic allow/deny per tool. No path scoping, no command
  normalization, no trust gate, no cost forecast, no capability model.
- **OpenCode**: allow/ask/deny triad with path and command patterns. No
  trust gate, no cost forecast, no capability model, no doom-loop detection.
- **Claude Code**: no permission system. Trusts the model entirely.
- **Codex**: no permission system.

Agency is the only harness with a full permission stack: tool-level,
path-level, command-level, trust gate, sandbox boundary, capability model,
cost forecast, and doom-loop detection -- all composable and all enforced
before any handler runs.

## Token efficiency

Agency treats token efficiency as an architectural property, not a tuning
knob. Every byte in the prompt has a reason, and every section is ordered
to maximize provider cache hits.

### Cache-prefix ordering

`packages/core/src/prompt/compose.ts` builds the system prompt in a fixed
order designed for cache stability:

```
stable prefix: base identity + family preset overlay + instructions + tool descriptions
dynamic suffix: context (environment block with date) + reminders
```

The stable prefix is byte-identical across turns where only the dynamic tail
changes. This is the provider's cache-breakpoint prefix: any incidental
reordering between turns would silently kill the cache hit rate. The comment
in the source is explicit about this:

> "This string is the provider's cache-breakpoint prefix, so any incidental
> reordering between turns would silently kill the cache hit rate."

The `composeSystemPrompt` function builds the stable prefix first, then
appends the dynamic sections. The `describePrompt` function exposes the
resolved sections for inspection via the `/prompt` RPC, so you can verify
the cache prefix is stable across turns.

### Provider-specific cache strategies

Each family preset in `packages/providers/src/presets.ts` declares its cache
strategy:

- **Anthropic**: `explicit-breakpoints` -- Agency marks cache breakpoints in
  the request body using Anthropic's `cache_control` markers. The stable
  prefix gets a breakpoint, the dynamic suffix does not.
- **OpenAI**: `automatic` -- OpenAI caches server-side without client
  markers. Agency's job is to keep the prompt prefix stable so the automatic
  cache hits.
- **Google**: `automatic` -- Same as OpenAI, server-side caching.
- **OpenAI-compatible**: `automatic` -- Assumes server-side caching; the
  adapter does not inject breakpoints.

The cache strategy is set once per family and consumed by the adapter during
request serialization. No per-turn logic, no config toggles.

### System reminders (no-padding guarantee)

System reminders (`packages/core/src/prompt/compose.ts`) are appended per-
turn, but only when active. The `formatSystemReminders` function returns
empty string for an empty list, and `withSystemReminders` returns the
composed prompt unchanged when there are no reminders. This means:

- Turns with no active reminders keep the exact same system prompt string
  (maximizing cache hits).
- Plan mode, file-changed notices, and MCP server-down notices only reach
  the model on the turns where they apply.

### Lean briefs and summaries

`packages/core/src/orchestra/parallel.ts` caps every subagent's context to
a lean slice:

- Brief: 2000 chars max (the task description).
- Summary: 500 chars max (what the parent sees of the child's result).
- Prompt excerpt: 200 chars max (persisted on task_result entries).
- Result preview: 80 chars max (UI rendering).

These caps mean a 5-agent parallel dispatch costs roughly the same input
tokens as one full-context turn, because each child sees only its brief
plus a one-line summary -- never the full conversation history.

### Tool output truncation

`packages/core/src/truncate.ts` caps every tool result before it re-enters
the conversation:

- 50,000 UTF-8 bytes per result.
- 2,000 lines per result.

Whichever limit is hit first. Truncated results keep their head and end
with a machine-readable notice. Error results get a distinct notice so the
model can tell a truncated failure from a truncated success. Results within
both limits pass through untouched, images included.

### Per-role model routing

`packages/core/src/prompt/compose.ts` defines role-specific prompts for
two model families:

- **Mechanics prompts** (Anthropic/Claude): explicit checklists, numbered
  steps, concrete procedures. 7 roles: leader, planner, plan-reviewer,
  coder, executor, explorer, researcher, code-reviewer.
- **Principle prompts** (everything else): concise principles, decision
  criteria, high-level guidance. Same roles, shorter form.

The `resolveFamilyPrompt` function selects the variant based on the
resolved model's family. Unknown families fall back to principle-driven.
This means Claude gets the structured prompts it works best with, and GPT/
DeepSeek/GLM get the concise prompts they work best with -- no single
prompt shape forced on every model.

### Effort mapping per provider

`packages/providers/src/effort-mapping.ts` maps Agency's 7 effort levels
(off, minimal, low, medium, high, xhigh, max) to each provider's native
thinking budget:

| Effort | Anthropic | OpenAI | Google | DeepSeek | GLM |
|---|---|---|---|---|---|
| off | - | - | 0 | - | - |
| minimal | 1024 | minimal | 512 | 1024 | 1024 |
| low | 2048 | low | 2048 | 2048 | 2048 |
| medium | 4096 | medium | 8192 | 4096 | 4096 |
| high | 8192 | high | 16384 | 8192 | 8192 |
| xhigh | 16384 | high | 24576 | 8192 | 8192 |
| max | 32000 | high | -1 (unlimited) | 16384 | 8192 |

The `clampEffortForModel` function never rejects -- it always returns a
valid effort level the model can use, clamped to the nearest supported
value. The `classifyEffortFromText` heuristic auto-selects effort from
task description text.

### What this means vs the alternatives

- **Cline**: basic truncation. No cache-prefix ordering, no lean context,
  no per-role prompts, no effort mapping.
- **OpenCode**: basic truncation. No cache-prefix ordering, no lean
  context, no per-role prompts, no effort mapping.
- **Claude Code**: provider-managed caching. No control over prompt
  structure, no lean subagent context, no per-role routing.
- **Codex**: provider-managed caching. No control over prompt structure.

Agency is the only harness that orders prompt sections for cache stability,
caps subagent context to lean slices, routes per-role prompts by model
family, and maps effort levels to each provider's native thinking budget --
all in one composable pipeline.

## Limitations (honest)

Agency is not a desktop app. There is no GUI, no Electron shell, no native
window. The interactive frontend is not included in this build. The primary
interfaces are the daemon RPC, the HTTP+SSE gateway, and the headless CLI.
Any mention of a desktop app is planned, not shipped. The `packages/tui`
frontend package has been removed pending the new frontend.

Agency does not include a Chromium browser. The `browser` tool is fetch+
parse, not a headless Chromium. There is no Playwright integration, no
puppeteer, no CDP. If you need real browser automation, you bring your own
MCP server.

Agency has no persistent cloud service. There is no hosted control plane,
no cloud sync, no team dashboard. Sessions are local files. Telemetry and
crash reports are off by default and local-only. See `docs/privacy.md`.

Agency's LSP integration is minimal. It feeds diagnostics after write/edit
for edit verification, but it is not a full IDE language server. Go-to-
definition, find-references, and rename are available through the LSP tool
but not deeply integrated into the loop.

Agency has no built-in container sandbox. The `SandboxBoundary` is a
software boundary (path resolution + command policy), not OS-level
isolation. The comment in the source is explicit: "This is a software
boundary, not OS isolation. It's the seam future work (containers,
namespaces) plugs into."

## Summary

Agency is the only coding harness that combines:

- **BYOK with a 4-layer resolution chain** and OS-native keychain storage
  across Windows, macOS, and Linux.
- **OAuth with PKCE and auto-refresh** for Anthropic, OpenAI, Google, and
  GitHub Copilot, with self-hosted gateway support.
- **Multi-agent orchestration** with handle-based registry, mailbox message
  passing, parallel spawn with PromiseBarrier, and cross-provider fallback
  chains spanning 3+ provider families.
- **Granular permission enforcement** with tool-level, path-level, and
  command-level rules, session-scoped grants, trust gate, sandbox boundary,
  capability model, cost forecast, and doom-loop detection.
- **Token efficiency as architecture** with cache-prefix ordering, lean
  subagent context, no-padding system reminders, per-role model routing,
  and per-provider effort mapping.

The tradeoff is that Agency is a headless backend. There is no GUI, no
Chromium, no cloud. You bring your own frontend, your own browser, your own
infrastructure. What you get in return is a harness that treats provider
flexibility, credential safety, subagent orchestration, permission
enforcement, and token efficiency as first-class architecture -- not
features bolted on after the fact.