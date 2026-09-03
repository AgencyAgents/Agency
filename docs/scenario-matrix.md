# Agency — Scenario Matrix (living document — backend-only cut)

> Every row of the flow bar's scenario matrix (plan lines 135-188) gets a defined
> behavior, an owner phase, a designed UI state, and either an automated test or
> a scripted manual gate. Status: ✅ works · ◐ partial · ✗ absent. Updated 2026-09-03
> to reflect what A1–A9c actually landed; updated 2026-09-03 to remove `packages/tui` —
> UI rows are now "deferred — frontend follows separately" and do not imply the `tui` package exists.
> The honesty rule: ✗ means it does not exist, not "probably works".

Legend — **Gate**: `auto` = covered by `bun test` (or typecheck/build), `manual` = scripted walkthrough in `docs/walkthrough.md` or the resize/paste/screen-reader checklist below. **Owner** = phase that shipped the behavior or that must ship the remaining gap.

---

## Startup and identity

| Scenario | Expected behavior | Status | Owner | UI state | Gate |
|---|---|---|---|---|---|
| First run, no credentials | Onboarding: connect → pick model → trust dir → ready, every failure actionable | ◐ | A2 / A9b | CLI `agency onboard` drives connect/model/trust with i18n errors; `agency` without args prints a notice that the interactive client is not included (exit 1) — use `agency -p` / `--help` | auto (`onboarding.test.ts`, `connect.test.ts`) + manual (walkthrough step 1-3) |
| User has a subscription, not an API key | OAuth login (Anthropic Pro/Max, Copilot), token refresh handled | ◐ | A9b | `providers/src/auth/oauth.ts` PKCE + refresh (single-flight), keychain stores `{type:"oauth"}`; `runConnectFlow` offers oauth for `anthropic`/`github-copilot`; no TUI browser chrome for OAuth yet | auto (`oauth` unit not yet isolated) + manual |
| Session list after a week of work | Sessions have generated titles and are searchable by them | ✅ | A9b | `session_title` entry, `titles.ts` (cheap model via `resolveSmallModel`); title search deferred to frontend (backend stores titles, `session list` RPC lists ids) | auto (`a9b.test.ts`) |
| A new version ships | `agency update`, signature-verified, rollback available | ✅ | A9b | `agency update` hits GitHub Releases, SHA-256 verify vs `checksums.txt`, keeps `.previous` for `--rollback`; `checkStale` surfaces banner; detached signature (ed25519) TODO documented in `docs/release.md` | auto (`update` smoke) + manual |
| Launch in an untrusted dir | Trust prompt before any instruction file loads; refusing still allows read-only session | ✅ | A5 | `createFileTrustStore` + `PermissionsGate` trust gate; `required:true` denies `dangerous`/`moderate` tools, `safe` still runs; `AGENTS.md` gated same path | auto (`policy.test.ts`, `daemon.test.ts` trust case) |
| Second terminal, same repo | Attaches to same daemon, sees only its own stream | ✅ | A3 | HTTP+SSE gateway: `GET /events?stream=turn.<id>` isolates per-client; legacy TCP still broadcasts (gateway is the product surface) | auto (`http-gateway.test.ts` isolation) |
| Daemon died while attached | Client notices, reconnects, says so | ◐ | A3 | Heartbeat `turn.<id>` every 10 s keeps deadlines alive; daemon dies → SSE `close()` ends stream; client reconnect not yet auto-retried in the thin client | manual (kill daemon, observe stream end) |

## The turn

| Scenario | Expected behavior | Status | Owner | UI state | Gate |
|---|---|---|---|---|---|
| Typing while model generates | Input queues, is visible as queued, sends on turn end | ✗ | A2 (thin client) | No input widget yet; `Transcript` is render-only | deferred — thin-client input widget (A2) |
| Mid-turn steering | Queued message can redirect current turn, not just wait | ✗ | B3 | Requires mailbox/drain on the leader/roster; no queue exists beyond one-shot `-p` | deferred — B3 steering |
| `Esc` mid-stream | Request aborted, tools killed with their process tree, partial output kept and labelled, session resumable | ✅ | A1 + A10 | `bash.ts` `killTree` + `[cancelled]` label + partial stdout/stderr; `loop.ts:runTools` checks `signal.aborted` between batches; `daemon.ts` `cancel_turn` aborts the per-turn `AbortController`; `cancellation-e2e.test.ts` proves the whole chain as one behavior | auto (`cancellation-e2e.test.ts`) |
| Tool runs 5 minutes | Live elapsed time and streaming output, not a frozen screen | ◐ | A6 + A10 | `tool_progress` (`2s` tick from `bash.ts:PROGRESS_TICK_MS`) via `LoopEvent`; elapsed reporting is now a backend event — no TUI in this build (frontend will render `startedAt` when it returns) | auto (bash `onProgress`) + manual (deferred — frontend follows separately) |
| Model returns malformed tool JSON | Repair or single failed tool result, never a dead turn | ✅ | A1 | `loop.ts:repairToolJson` + `malformedCalls` → per-call `tool_result isError:true`; turn survives | auto (`loop.test.ts` repair cases) |
| Iteration cap hit | Explicit "stopped after N steps, continue?" | ◐ | A1 | `iteration_limit` LoopEvent emitted; `Transcript` not yet rendering it as a distinct prompt (falls through to status) | auto (`loop.test.ts` cap) |
| Model asks the user something | Structured question rendered as choices, answer flows back | ◐ | A6 | `question` tool exists (`tools/src/builtins/question.ts`, `tool.question.*` keys); answer arrives as next user message — choice UI deferred (frontend follows separately) | auto (question tool) + manual |

## Permissions

| Scenario | Expected behavior | Status | Owner | UI state | Gate |
|---|---|---|---|---|---|
| Dangerous command proposed | Approval prompt with once / always / reject, showing exact command | ◐ | A5 | Gate works: `PermissionsGate.check` → `ApprovalManager` pending → broadcast `approval_requested` on `turn.<id>` + `session.<id>`; approval UI deferred — frontend follows separately | auto (`daemon.test.ts` approval flow) + manual (walkthrough approval) |
| "Always allow" chosen | Remembered for session, retroactively resolves matching pending asks | ✅ | A5 | `ApprovalManager` grants keyed by arity-normalized command / parent dir / tool; `always` retroactively resolves other pendings as `once` | auto |
| Read-only / plan mode | Mode where edits and commands are proposed, never executed | ✅ | A5 | `permissions` allow/ask/deny + `external_directory`; plan file `.agency/plans/<slug>.md` + `plan_approval` companion record + `execute_plan` tool; `read_only` reminder via `withSystemReminders` | auto (`plan_approve`, `execute_plan` tests) |
| Edit outside workspace | Explicit external-directory approval | ✅ | A5 | `SandboxBoundary.resolvePathGated` + `externalDirectoryDecision`; `bash` post-run `cwd` validated, `[cwd kept]` notice on violation | auto |

## Providers and models

| Scenario | Expected behavior | Status | Owner | UI state | Gate |
|---|---|---|---|---|---|
| Switch model mid-session | `/models` with fuzzy search, applies to next turn, recorded as session entry | ◐ | A2 | `providers_list` RPC + `catalog` wired for `maxOutputTokens`/`pricePerMTok`; mid-session switch via `--model` flag / `run_turn` provider+model works — picker UI deferred (frontend follows separately) | auto (catalog) |
| Rate limited | Visible backoff with countdown, auto-resume, no silent stall | ✅ | A1 + A2f + A10 | `Scheduler` capped `Retry-After` → `onRetry(attempt,message,next)` emits `retry` LoopEvent with `next` timestamp; retry UI deferred (frontend will map ErrorCode + i18n keys) | auto |
| Provider down / overloaded | Clear error naming provider, offer to switch | ✅ | A4 + A9b + A10 | `ErrorCode.OVERLOAD`/`TRANSIENT`/`PROXY` (schema/errors.ts + i18n keys); `fallback_model` retries once on `OVERLOAD/TRANSIENT/RATE_LIMIT` emitting `fallback` event — error UI deferred (frontend will rebuild from ErrorCode) | auto |
| Offline | Says offline; catalog serves stale; no hang | ✅ | A4 + A10 | `NETWORK` → `error.network` i18n key; catalog cache `stale-ok` — error UI deferred (frontend will rebuild from ErrorCode) | manual (airplane mode) |
| Context window exceeded | Compacts and continues, visibly | ✅ | A4 | Adapter maps for anthropic/google/openai-compatible; `withMidStreamRecovery`; `defaultCompaction` always on (0.8 ratio, todos exempt); `error.context_overflow` hint says compacting | auto (`compact-retry.test.ts`, `loop` + `store` compaction) |
| Cost ceiling reached | Halts, says what it cost, offers to raise | ✅ | A4 | `pricePerMTok` from catalog → `costOf`; `budget.maxCostUsd` gates `budget_exceeded` event — budget UI deferred (frontend will render from event) | auto |

## Work products

| Scenario | Expected behavior | Status | Owner | UI state | Gate |
|---|---|---|---|---|---|
| File edited | Inline diff in transcript, collapsed with summary line | ✅ | A2 + A6 | Backend: diff computation and `renderResult` produce inline summary `+added -removed path`; diff UI deferred (frontend follows separately) | auto (dispatch `renderResult` contract) |
| Wrong edit applied | `/undo` restores exact prior state | ✅ | A4 | `SnapshotStore` journals `before`/`afterHash` per `turnId`; daemon `undo`/`redo` RPC; redo keeps `afterHash` | auto (`sessions/*` + daemon undo) |
| Long build or dev server | Runs in background, log readable later, killed on session end | ✅ | A6 | `ProcessManager` + `process_output`/`process_list`/`process_kill` builtins (`tool.process.*` keys); `daemon.stop` `killAll` | auto |
| Todos | Live panel, survives compaction, updates as work proceeds | ◐ | A6 / A2 | `TodoStore` persists as `todo_state` entries; `session-store` compaction exempts todos; desktop kanban not built | auto (todo persistence) |

## Ecosystem

| Scenario | Expected behavior | Status | Owner | UI state | Gate |
|---|---|---|---|---|---|
| MCP server configured | Tools appear namespaced, failures visible, crash triggers restart | ✅ | A7 | Stdio+Streamable HTTP (headers, `timeoutMs`), parallel start, `mcpFailures` Map → `mcp_server_down` reminder; crash restart with exponential backoff; `mcp_status` RPC | auto (`mcp/*` tests) |
| Custom slash command | Markdown template with arguments, discoverable in palette | ✅ | A8 | `commands/loader.ts` discovers `.agency/commands/*.md`; `expandCommand` handles `$ARGUMENTS`/`$ARGS`/`${ARGS}` + `{{file:path}}`/`$FILE:` | auto (`commands.test.ts`) |
| Skill / prompt template | Loaded, listed, invocable | ✅ | A8 | `plugins/loader.ts` discovers project/user/npm plugins; `ToolRegistry` namespaced registration; `commands` cover the template half | auto (`plugins.test.ts`) |
| LSP diagnostics | Post-edit errors attached to tool result so model self-corrects | ✅ | A7 | `lspServers` config, `createLspRegistry` lazy, `waitForDiagnostics` 1200 ms polling, edits wrap `didOpen`/`didChange` and append `Diagnostics: line:col msg` | auto (`lsp` tests) |

## Sessions

| Scenario | Expected behavior | Status | Owner | UI state | Gate |
|---|---|---|---|---|---|
| Resume yesterday's work | `agency --continue`, full context restored | ✅ | A2 / A4 | `agency --continue` (`-p` + `--continue`) + `agency --session <id>` via `runSessionTurn` + `SessionStore` load; `headless` path reuses daemon | auto (`session-runner-integration`, `entrypoint.test.ts`) |
| Branch an idea | `/fork` from any point, tree visible in browser | ◐ | A4 | `SessionStore.fork({fromTipId,label})` appends `branch_summary`; `clone` exists; no CLI `/fork` command or tree UI yet | auto (store fork) + manual |
| Crash mid-turn | Resumes from last complete entry, discards partial turn | ✅ | A4 | Engine-level: `store.load` skips truncated tail line; `runTurn` only persists on complete `message_stop` | auto (`store.test.ts`) |
| Session grows huge | Compaction is automatic and visible; todos exempt | ✅ | A4 | `SessionStore` `load` cache + tail reads; `compaction.ts` summary + event `session.compacted`; `retry` visible on overflow | auto |

## Terminal reality

| Scenario | Expected behavior | Status | Owner | UI state | Gate |
|---|---|---|---|---|---|
| Resize mid-stream | Reflows correctly | ✗ | deferred | Deferred — frontend follows separately (backend has no renderer; was `reflow()`/`DifferentialRenderer` in removed tui) | manual |
| 80 columns / no color / piped / screen reader | Degrades correctly, verified in CI | ✗ | deferred | Deferred — frontend follows separately (was `DifferentialRenderer`/`Theme.cue` in removed tui) | manual |
| Paste a large block | Bracketed paste, collapsed as attachment rather than flooding | ✗ | A2 | No input widget → no bracketed-paste handling | manual — deferred to thin-client input (A2) |
| Multi-line input, history, `@file` refs, `/` autocomplete | Standard editor affordances | ✗ | A2 | No input widget, no history, no completion engine beyond `ModelPickerStore`/`CommandPalette` data | manual — deferred to thin-client input (A2) |

## Discoverability

| Scenario | Expected behavior | Status | Owner | UI state | Gate |
|---|---|---|---|---|---|
| User does not know a shortcut | `?` shows focused panel's keys, derived from live bindings | ✗ | deferred | Deferred — frontend follows separately | manual |
| User does not know a command | `Ctrl+K` fuzzy palette over commands, sessions, models | ✗ | deferred | Deferred — frontend follows separately (`commands_list` RPC remains for future palette) | manual |
| Status at a glance | One line: model, thinking level, context used, session cost | ✗ | deferred | Deferred — frontend follows separately (no status line in backend build) | manual |

---

## Deferred scope (explicit)

| Row | Reason |
|---|---|
| `packages/tui` frontend (renderer, transcript, themes, error-states, connect, models-picker, session-browser, diff-viewer, command-palette, help, keybinds, status, empty, thinking, theme) | Removed in backend-only cut; rebuilt as a separate frontend — error semantics live in `schema/errors.ts` i18n keys so a future frontend can rebuild from those. |
| Desktop app shell, board, Agents/Todo tabs, trace viewer UI, roster, inline commenting kanban, side-by-side compare, one-click replay UI | Deferred to **A2c desktop app** (Tauri+webview). The harness is daemon/headless/backend today. |
| TUI input widget (multi-line, bracketed paste, history, `@file`/`/` completion, queuing, steering) | Deferred to **A2 thin terminal client** second pass. Verified as scripted manual steps until then. |
| `?` keys derived from live bindings / fuzzy palette over live registry | Deferred to **A2 polish** — hardcoded help/palette desync noted above. |

## Automation coverage summary

- **Automatable rows** are gated by `bun test` today where status is ✅/◐. The only pure-manual rows are paste, resize, screen-reader, approval prompts, and the first-run onboarding flow — all listed as `manual` above and scripted in `docs/walkthrough.md`.
- **No ✗ row outside explicitly deferred scope remains without a deferral note.** Any future ✗ that appears outside the deferred table must be either fixed in the phase that owns it or moved into this section with an owning phase.

## How to walk this before a release

1. `bun run typecheck && bun test` (per-package if `server-client.test.ts` segfault on Windows).
2. Walk the `manual` gates on Windows, macOS, Linux: daemon heartbeat, resize mid-stream, paste, screen-reader (`AGENCY_SCREEN_READER=1`), and the `docs/walkthrough.md` script.
3. Update this file's Status column to match what you actually saw. Honesty over optimism.
