# Agency — First 15 Minutes (scripted manual gate)

> Run this before each release on Windows, macOS, and Linux, on a clean
> checkout, without reading any doc other than this one. Anywhere you
> hesitate is a defect, not a training issue. Timebox: 15 minutes.
>
> Mark each step `[auto]` if `bun test` covers it, `[manual]` if you must
> see it with your own eyes. Both kinds must pass.

Pre-req: `bun` ≥ 1.4, no existing `~/.config/agency` or project `.agency/` you
care about (the walkthrough writes config, trust, sessions, and keychain
entries). Network optional for offline steps.

---

### 0. Install (2 min) — [manual]

| Step | Do | Expect |
|---|---|---|
| 0.1 | `bun install` | No errors, lockfile respected |
| 0.2 | `bun run build:bin` (or just `bun run typecheck` if you skip the binary) | Binary at `dist/agency` or typecheck clean |
| 0.3 | `agency --help` | Lists `where, storage, session, auth, onboard, debug, update, serve` plus `-p/--print` flags |
| 0.4 | `agency where` | Prints every path the harness reads/writes; no crash on any platform |

### 1. Launch (1 min) — [auto via headless] + [manual for TUI hint]

| Step | Do | Expect |
|---|---|---|
| 1.1 | `agency` with no args in a TTY | Hint: "Agency TUI: run in a terminal with a TTY. Use --help for commands." (exit 0, no crash) |
| 1.2 | `agency --version` | Version string, no stack trace |

### 2. Connect — first provider (3 min) — [auto] + [manual gate: no credentials message]

| Step | Do | Expect |
|---|---|---|
| 2.1 | `agency auth list` before connecting | Each builtin provider shows `not connected` |
| 2.2 | `agency onboard` (or `agency auth login openai`) | Prompts for provider id and API key via hidden input; on success prints `Key for <provider> stored in <backend>` via `tui.connect.stored`; invalid id prints `tui.connect.invalid_id`; empty key prints `tui.connect.no_key` and stores nothing |
| 2.3 | `agency auth list` after | Connected provider shows `connected` |
| 2.4 | *(offline variant)* Disconnect network, `agency auth login <provider>` with a bad key | Either `tui.connect.stored` + `tui.connect.unverified` or a clear network error via `error-states.ts` — never a raw stack trace |

**Automatable:** `onboarding.test.ts`, `connect.test.ts`, `entrypoint.test.ts` cover the i18n paths.
**Manual gate:** Verify on each OS that the hidden-key prompt actually hides input in the real terminal (not just in tests).

### 3. First turn (3 min) — [auto]

| Step | Do | Expect |
|---|---|---|
| 3.1 | `agency -p "say hello in one word"` | Prints the model's word; exit 0; no daemon leak (second call reuses daemon) |
| 3.2 | `agency -p "say hello" --format json` | JSON with `messages`, `stopReason`, `usage`, `cancelled:false`; no key in output |
| 3.3 | `agency -p "what files are here?"` (or any tool-calling prompt) | If the model calls `read`/`glob`/`grep`, tool calls appear via the harness; no English string leaks outside `@agency/i18n` |

**Automatable:** `headless-coverage.test.ts`, `session-runner-integration.test.ts`, `daemon.test.ts`.

### 4. An edit (2 min) — [auto] + [manual: verify diff]

| Step | Do | Expect |
|---|---|---|
| 4.1 | `agency -p "create a file hello.txt containing 'hi'" --session walkthrough` | `tool.write.wrote` style result; file exists on disk |
| 4.2 | `agency -p "edit hello.txt: change 'hi' to 'hello world'" --session walkthrough` | `tool.edit.applied` (or `hunks_applied`), no clobber warning; file now contains `hello world` |
| 4.3 | `agency session list` | Lists `walkthrough` with entry count > 0 |
| 4.4 | *(optional desktop path)* Open the session in the transcript viewer / `Transcript` frame dump | Inline diff shows `+`/`-` lines, `diff-viewer.test.ts` semantics: real LCS, not positional zip |

**Automatable:** `builtin-tools-integration.test.ts`, `diff-viewer.test.ts`, `daemon` undo/redo not yet exercised here.

### 5. An undo (1 min) — [auto]

| Step | Do | Expect |
|---|---|---|
| 5.1 | `agency -p "change hello.txt to 'oops'" --session walkthrough` then invoke `undo` RPC (today: `curl` or test harness against the daemon, since `agency undo` CLI alias is not yet surfaced) | `undo` returns `{undone:true, path}`; `hello.txt` content reverts to `hello world` |
| 5.2 | `redo` RPC | Content returns to `oops`; `afterHash` preserved (redo without afterHash would skip) |

**Automatable:** `sessions/store.test.ts` snapshots, `daemon.test.ts` undo/redo RPC.
**Manual gate:** Confirm the daemon-owned snapshot journal actually restores exact bytes (not just "a file changed").

### 6. A cancelled command (2 min) — [auto: cancellation-e2e] + [manual: feel Esc]

| Step | Do | Expect |
|---|---|---|
| 6.1 | `agency -p "run a shell command that sleeps 30 seconds" --session walkthrough` → press `Esc` mid-run (or call `cancel_turn` over RPC within 5 s of the marker) | Bash output preserves whatever was printed before the kill plus `[cancelled: command aborted before completion]`; exit code is not 0; no orphaned grandchildren (check with `ps` or `Get-Process`) |
| 6.2 | Inspect the transcript/session: the cancelled `tool_result` is `isError:false` content with the cancelled label (retryable tool_error class), not a fatal `error` LoopEvent that killed the turn | Status line shows `cancelled` in `warning` style via `error-states.ts` |
| 6.3 | *(screen-reader variant)* `AGENCY_SCREEN_READER=1 agency -p "..."` with the same cancel | Spoken cue is `warn`/`error` words, never glyphs; ANSI stripped |

**Automatable:** `packages/cli/test/cancellation-e2e.test.ts` — marker-file polling, generous 30 s timeout, asserts: partial output contains first line + `[cancelled]`, session resumable. See `docs/scenario-matrix.md` turn row.
**Manual gate:** On each OS, hold `Esc` with a real `sleep`/`timeout` child that spawns its own child; verify the whole tree dies (the `killTree` private via `ProcessManager` must not orphan).

### 7. A resumed session (1 min) — [auto]

| Step | Do | Expect |
|---|---|---|
| 7.1 | `agency -p "say resumed" --continue` | Continues the most recent session (`walkthrough`); prints `resumed`; no "Unknown session" error |
| 7.2 | `agency -p "say hello" --session walkthrough --format json` after a cancellation | Succeeds (session not poisoned by the abort); `cancelled:false` in the new result |
| 7.3 | `agency session delete walkthrough` | Prints `Deleted session walkthrough`; subsequent `agency session list` no longer shows it; `*.trace.jsonl` and `*.cassette.json` sidecars deleted too |

**Automatable:** `session-runner.test.ts`, `store.test.ts`, `daemon.test.ts` lifecycle, plus the second half of `cancellation-e2e.test.ts` (proves resumability as one behavior).

### 8. Bonus liveness checks (while any tool runs) — [manual]

| Check | How | Expect |
|---|---|---|
| Retry countdown | Point `agency` at a fake provider that returns 429 with `Retry-After: 5` | Transcript shows `retry 1: … — retrying at <time>` via `tui.retry.next` using the `next` timestamp from `LoopEvent`; no frozen screen |
| Elapsed time | Run a tool that sleeps 5 s | Tool row shows `  Ns` ticking (e.g. `bash sleep 5  3s`) via `transcript.ts:startedAt` |
| Compaction visible | Fill context to overflow on Anthropic/OpenAI/Google | `error.context_overflow` message plus automatic continuation; todos not dropped |

---

## Pass criteria

- All `[auto]` rows stay green without touching source or docs: `bun run typecheck` clean, `bun test packages/cli` all pass (including `cancellation-e2e`), and per-package suites for `core`/`tui`/`tools`.
- All `[manual]` rows were walked on the releasing machine and the `scenario-matrix.md` status column was updated to match what you saw. A step that required guessing or a retry is a failure — file it, don't excuse it.

## Cleanup

```sh
agency session delete walkthrough  # or rm -rf $(agency where --format json | jq -r .sessionsDir)/walkthrough.jsonl
```

If you ran on a temp workspace, just delete the workspace directory; daemon instance files live under `dataDir()/instances` and are reaped on idle.
