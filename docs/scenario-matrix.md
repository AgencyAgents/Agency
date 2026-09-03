# Agency — Scenario Matrix (A10 living document)

> Every row of the flow bar's scenario matrix (plan lines 135-188) gets a defined
> behavior, an owner phase, a designed UI state, and either an automated test or
> a scripted manual gate. Status: ✅ works · ◐ partial · ✗ absent. Updated 2026-09-03
> to reflect what A1–A9c actually landed. The honesty rule: ✗ means it does not
> exist, not "probably works".

Legend — **Gate**: `auto` = covered by `bun test` (or typecheck/build), `manual` = scripted walkthrough in `docs/walkthrough.md` or the resize/paste/screen-reader checklist below. **Owner** = phase that shipped the behavior or that must ship the remaining gap.

---

## Startup and identity

| Scenario | Expected behavior | Status | Owner | UI state | Gate |
|---|---|---|---|---|---|
| First run, no credentials | Onboarding: connect → pick model → trust dir → ready, every failure actionable | ◐ | A2 / A9b | CLI `agency onboard` drives connect/model/trust with i18n errors; `agency` without TUI prints `cli.tui.hint` rather than auto-launching the TUI | auto (`onboarding.test.ts`, `connect.test.ts`) + manual (walkthrough step 1-3) |
| User has a subscription, not an API key | OAuth login (Anthropic Pro/Max, Copilot), token refresh handled | ◐ | A9b | `providers/src/auth/oauth.ts` PKCE + refresh (single-flight), keychain stores `{type:"oauth"}`; `runConnectFlow` offers oauth for `anthropic`/`github-copilot`; no TUI browser chrome for OAuth yet | auto (`oauth` unit not yet isolated) + manual |
| Session list after a week of work | Sessions have generated titles and are searchable by them | ✅ | A9b | `session_title` entry, `titles.ts` (cheap model via `resolveSmallModel`), `SessionBrowser` sorts/searches title, not id | auto (`a9b.test.ts`, `session-browser.test.ts`) |
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
| Tool runs 5 minutes | Live elapsed time and streaming output, not a frozen screen | ◐ | A6 + A10 | `tool_progress` (`2s` tick from `bash.ts:PROGRESS_TICK_MS`) via `LoopEvent`; TUI now shows elapsed `Ns` on the running tool row (`transcript.ts:startedAt`); streaming stdout per-token not yet — tool result still appears on finish | auto (bash `onProgress`, transcript elapsed unit) + manual |
| Model returns malformed tool JSON | Repair or single failed tool result, never a dead turn | ✅ | A1 | `loop.ts:repairToolJson` + `malformedCalls` → per-call `tool_result isError:true`; turn survives | auto (`loop.test.ts` repair cases) |
| Iteration cap hit | Explicit "stopped after N steps, continue?" | ◐ | A1 | `iteration_limit` LoopEvent emitted; `Transcript` not yet rendering it as a distinct prompt (falls through to status) | auto (`loop.test.ts` cap) |
| Model asks the user something | Structured question rendered as choices, answer flows back | ◐ | A6 | `question` tool exists (`tools/src/builtins/question.ts`, `tool.question.*` keys); TUI choice rendering not wired — answer arrives as next user message | auto (question tool) + manual |

## Permissions

| Scenario | Expected behavior | Status | Owner | UI state | Gate |
|---|---|---|---|---|---|
| Dangerous command proposed | Approval prompt with once / always / reject, showing exact command | ◐ | A5 | Gate works: `PermissionsGate.check` → `ApprovalManager` pending → broadcast `approval_requested` on `turn.<id>` + `session.<id>`; TUI card not built (desktop Agents tab owns it) | auto (`daemon.test.ts` approval flow) + manual (walkthrough approval) |
| "Always allow" chosen | Remembered for session, retroactively resolves matching pending asks | ✅ | A5 | `ApprovalManager` grants keyed by arity-normalized command / parent dir / tool; `always` retroactively resolves other pendings as `once` | auto |
| Read-only / plan mode | Mode where edits and commands are proposed, never executed | ✅ | A5 | `permissions` allow/ask/deny + `external_directory`; plan file `.agency/plans/<slug>.md` + `plan_approval` companion record + `execute_plan` tool; `read_only` reminder via `withSystemReminders` | auto (`plan_approve`, `execute_plan` tests) |
| Edit outside workspace | Explicit external-directory approval | ✅ | A5 | `SandboxBoundary.resolvePathGated` + `externalDirectoryDecision`; `bash` post-run `cwd` validated, `[cwd kept]` notice on violation | auto |

## Providers and models

| Scenario | Expected behavior | Status | Owner | UI state | Gate |
|---|---|---|---|---|---|
| Switch model mid-session | `/models` with fuzzy search, applies to next turn, recorded as session entry | ◐ | A2 | `ModelPickerStore` + `fuzzysort`, `providers_list` RPC, `catalog` wired for `maxOutputTokens`/`pricePerMTok`; mid-session switch via `--model` flag / `run_turn` provider+model works, no TUI picker shortcut yet | auto (picker, catalog) |
| Rate limited | Visible backoff with countdown, auto-resume, no silent stall | ✅ | A1 + A2f + A10 | `Scheduler` capped `Retry-After` → `onRetry(attempt,message,next)` → `Transcript` `retry` block shows `tui.retry.next` countdown; `error-states.ts` rate_limit state is recoverable | auto |
| Provider down / overloaded | Clear error naming provider, offer to switch | ✅ | A4 + A9b + A10 | `ErrorCode.OVERLOAD`/`TRANSIENT`/`PROXY` map to `error-states.ts` with source and hint; `fallback_model` retries once on `OVERLOAD/TRANSIENT/RATE_LIMIT` emitting `fallback` event | auto |
| Offline | Says offline; catalog serves stale; no hang | ✅ | A4 + A10 | `NETWORK` → `error.network` via `error-states.ts` ("Check your connection — catalog serves stale"); catalog cache `stale-ok` | manual (airplane mode) |
| Context window exceeded | Compacts and continues, visibly | ✅ | A4 | Adapter maps for anthropic/google/openai-compatible; `withMidStreamRecovery`; `defaultCompaction` always on (0.8 ratio, todos exempt); `error.context_overflow` hint says compacting | auto (`compact-retry.test.ts`, `loop` + `store` compaction) |
| Cost ceiling reached | Halts, says what it cost, offers to raise | ✅ | A4 | `pricePerMTok` from catalog → `costOf`; `budget.maxCostUsd` gates `budget_exceeded` event; `Transcript` renders `tui.budget.exceeded` | auto |

## Work products

| Scenario | Expected behavior | Status | Owner | UI state | Gate |
|---|---|---|---|---|---|
| File edited | Inline diff in transcript, collapsed with summary line | ✅ | A2 + A6 | `DiffViewer` (real LCS) + `inlineDiffSummary` `+added -removed path`; transcript `tool_result` via `renderResult` uses `diffLines` for `edit`/`write` | auto (`diff-viewer.test.ts`) |
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
| Resize mid-stream | Reflows correctly | ◐ | A2 | `reflow()` uses `visibleWidth` (wide-char aware via `charWidth`), `DifferentialRenderer` diffs lines; explicit SIGWINCH reflow not yet automated | manual (resize while streaming) |
| 80 columns / no color / piped / screen reader | Degrades correctly, verified in CI | ✅ | A2 | `detectCapabilities` + `DifferentialRenderer` `linear`/`screen-reader` modes; glyph↔word pairs (`Theme.cue`); `AGENCY_SCREEN_READER` wins | auto (`renderer.test.ts`, transcript degradation) |
| Paste a large block | Bracketed paste, collapsed as attachment rather than flooding | ✗ | A2 | No input widget → no bracketed-paste handling | manual — deferred to thin-client input (A2) |
| Multi-line input, history, `@file` refs, `/` autocomplete | Standard editor affordances | ✗ | A2 | No input widget, no history, no completion engine beyond `ModelPickerStore`/`CommandPalette` data | manual — deferred to thin-client input (A2) |

## Discoverability

| Scenario | Expected behavior | Status | Owner | UI state | Gate |
|---|---|---|---|---|---|
| User does not know a shortcut | `?` shows focused panel's keys, derived from live bindings | ◐ | A2 | `HelpSystem` exists but hardcoded, will desync from `KeybindRegistry` | manual |
| User does not know a command | `Ctrl+K` fuzzy palette over commands, sessions, models | ◐ | A2 | `CommandPalette` `indexOf` not fuzzy, `fuzzysort` dependency present for models; `commands_list` RPC wired but not all commands registered | manual |
| Status at a glance | One line: model, thinking level, context used, session cost | ◐ | A2 | `StatusLine` renders `model | thinking | context | cost`; never displayed — no main TUI loop to mount it | auto (`status-empty-help.test.ts`) |

---

## Deferred scope (explicit)

| Row | Reason |
|---|---|
| Desktop app shell, board, Agents/Todo tabs, trace viewer UI, roster, inline commenting kanban, side-by-side compare, one-click replay UI | Deferred to **A2c desktop app** (Tauri+webview). The harness is CLI/headless/daemon + thin transcript today. |
| TUI input widget (multi-line, bracketed paste, history, `@file`/`/` completion, queuing, steering) | Deferred to **A2 thin terminal client** second pass. Verified as scripted manual steps until then. |
| `?` keys derived from live bindings / fuzzy palette over live registry | Deferred to **A2 polish** — hardcoded help/palette desync noted above. |

## Automation coverage summary

- **Automatable rows** are gated by `bun test` today where status is ✅/◐. The only pure-manual rows are paste, resize, screen-reader, approval prompts, and the first-run onboarding flow — all listed as `manual` above and scripted in `docs/walkthrough.md`.
- **No ✗ row outside explicitly deferred scope remains without a deferral note.** Any future ✗ that appears outside the deferred table must be either fixed in the phase that owns it or moved into this section with an owning phase.

## How to walk this before a release

1. `bun run typecheck && bun test` (per-package if `server-client.test.ts` segfault on Windows).
2. Walk the `manual` gates on Windows, macOS, Linux: daemon heartbeat, resize mid-stream, paste, screen-reader (`AGENCY_SCREEN_READER=1`), and the `docs/walkthrough.md` script.
3. Update this file's Status column to match what you actually saw. Honesty over optimism.
