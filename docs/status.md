# Status

Built means implemented and tested. Wired means a production caller
invokes it. Planned means designed in docs/orchestration.md but not
implemented. Unwired rows name what stands in for the mechanism today.

| Item | Built | Wired | Planned |
|---|---|---|---|
| TeamStore and appendMessage broadcast | Yes, with tests | Partial: `ensureTeamForLeadSession` pins one team per lead session; board tools (`board_read`, `board_claim`, `board_status`, `task_file`) plus `owners_read` are per-agent gated tools | Team lifecycle with team IDs per turn |
| Retired early-draft team names | No: the names have zero source hits | No | Nothing: the vocabulary is retired in favor of team |
| Per-role prompts and resolveFamilyPrompt | Yes, tables plus selector with tests | Partial: file bodies from `.agency/agents` feed dispatch through `initTeamFromConfig`; the built-in tables still have no runtime caller | Layered prompt architecture with per-model length |
| File-based agents (`.agency/agents` plus `resolveFileRoster`) | Yes: `parseAgentFile` validates `role`, `provider`, `model`, `effort`, `tools`, `permissions`, `pathScope` with the body as the role prompt, with tests | Yes: `initTeamFromConfig` seeds `DEFAULT_ROSTER` on first run, `agents_list` serves file roles, `importClaudePlugin` writes imports as files, `collectPluginAgents` registers plugin agents | Prompt layering per model |
| Team protocol text and appendTeamProtocol | Yes, baked into role tables | Partial: present in prompt strings, never shown to a peer at runtime | Playbook as the shared cached prefix |
| planDispatchBatch and DispatchStateStore | Yes, with tests | Yes: daemon dispatch plans every batch through `planDispatchBatch` (inline skips stay as race guards); `planBoardBatch` reuses it for board items at depth 0 | Board as the delegation ledger |
| Category routing and runWithCategoryFallback | Yes, with tests | No: the daemon retries one configured fallback_model once | Capability routing behind the delegation check |
| Cheap routing (selectModel, withCheapFallback) | Yes, with tests | Partial: honored inside runTurn via taskKind and cheapModel, which the daemon never sets | Digest builder giving cheap models a real job |
| Session and config surface (session_list, session_create, session_export, session_rename, models_list, config_get, config_set, permissions_list, todo_read, todo_write, cost_report, undo_run, prompt_inspect) | Yes, with tests | Yes: served over /rpc and the SDK surface; session todos hand off via `todosToBoard` and `boardToTodos` | Phase 8 generalizes undo_run to team runs; Phase 9 adds budgets, caps, and cache-premium accounting |
| `session_send` with daemon-owned sessions | Yes: `session_send` owns store, history, tokenizer, compaction, appends, and usage, with tests | Yes: `runSessionTurn` is a thin consumer sending text and streaming events; `run_turn` keeps its caller-owned shape | The two-crossing boundary protocol |
| Team isolation (per-team sessions, worktrees, inboxes) | Yes: children keyed by parent session, handle, and batch with namespaced worktrees and fail-closed creation | Yes: dispatch and dispatch_compare isolate sessions, worktrees, inboxes, and cost per parent; SessionScope teamId marks child scopes; claimed items layer `withItemScope` over the agent gate | Disjoint path scopes plus lead-owned integration |
| Resumable events across reconnects | Yes: EventRing issues monotonic ids with retry frames, Last-Event-ID gap-tails, the state frame covers over-buffer reconnects | Yes: /events serves ids, retry, backlog, and state on every connect | None |
| SDK (connect, createAgencyClient, createSurfaceClient) | Yes: generated.ts emits every RPC method plus GatewayEvent types from /doc | Yes: the SDK-only script drives create, send, stream, approve, cost report, export | None |
| Headless permission modes (`PermissionMode`) and bounded approvals | Yes, with tests | Yes: --permission-mode selects ask, allow-edits, or deny; `createPending` fails closed with a typed reason | Headless runs that never stall on an ask |
| At-handle routing (`parseHandles`) | Yes | Yes: lone mentions rewrite provider, model, and effort inline, including through `session_send` | Selection model with escalation never a user choice |
| Compaction (0.9 trigger, 0.7 target, 20K cap) | Yes | Yes daemon-side via `session_send` (proactive plus reactive `onContextOverflow`); `run_turn` keeps `needsCompaction` for caller-owned turns; team agent windows compact item-aware with `item_state` surviving `planCompaction` | Cache-event accounting |
| OAuth (PKCE plus device flow) | Yes | Blocked: all shipped client IDs are placeholders rejected by assertClientIdConfigured | Same flows once the user registers an app |
| Scheduler multi-key rotation (scheduleWithKeys) | Yes, with tests | No | Model ladder escalation across families |
| Progress checklist store | Yes, with tests | Yes: `boardToPlanFile` projects tasks to Todos and reviews to Final, `planFileToBoard` picks up human edits, `ProgressStore` carries per-item agent attribution, state lives at `.agency/progress.json` with `.omo/perseverance.json` legacy import | None |
| Session projector (SessionProjector, projectSessionView) | Yes, with tests | Yes: session_show and the SSE state frame both render through projectSessionView | None |
| dispatch_compare via spawnParallel | Yes | Yes: the only production caller of spawnParallel | Lateral delegation replacing fan-out |
| checkDepthGate | Yes | Yes: called by the dispatch tool | Flat team with no depth counter |
| Eval harness (pass-rate and cost per task per roster) | Yes: `scoreReport` over `loadCassettes` with tests | Yes: run.ts replays cassettes through `replayTask` with zero provider calls and writes the baseline; disjoint scopes show zero conflicts on multi-1 | Phase 8 reviewer-first cites the baseline |
