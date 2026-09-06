# Status

Built means implemented and tested. Wired means a production caller
invokes it. Planned means designed in docs/orchestration.md but not
implemented. Unwired rows name what stands in for the mechanism today.

| Item | Built | Wired | Planned |
|---|---|---|---|
| TeamStore and appendMessage broadcast | Yes, with tests | No: zero non-test instantiations, no team RPC, no team tool | Team lifecycle with team IDs per turn |
| OrchestraRoom, swarm-leader, swarm-peer | No: the names have zero source hits | No | Nothing: the vocabulary is retired in favor of team |
| Per-role prompts and resolveFamilyPrompt | Yes, tables plus selector with tests | No: no runtime caller passes their output; peers get a literal one-line prompt | Layered prompt architecture with per-model length |
| Team protocol text and appendTeamProtocol | Yes, baked into role tables | Partial: present in prompt strings, never shown to a peer at runtime | Playbook as the shared cached prefix |
| planDispatchBatch and DispatchStateStore | Yes, with tests | No: the daemon reimplements the unknown-handle and budget skips inline | Board as the delegation ledger |
| Category routing and runWithCategoryFallback | Yes, with tests | No: the daemon retries one configured fallback_model once | Capability routing behind the delegation check |
| Cheap routing (selectModel, withCheapFallback) | Yes, with tests | Partial: honored inside runTurn via taskKind and cheapModel, which the daemon never sets | Digest builder giving cheap models a real job |
| Phantom RPCs (models_list, session_list, session_get, session_export, prompt) | No: absent from the handler table | No | session_send, single projectors, versioned event catalog |
| session_send with daemon-owned sessions | No | No: run_turn takes the session from the caller; runSessionTurn owns the store client-side | The two-crossing boundary protocol |
| Team isolation (per-team sessions, worktrees, inboxes) | Partial: SessionScope isolates tools and state per session | No: handles, worktrees, inboxes, and cost maps are daemon-global; SessionScope teamId is never set | Disjoint path scopes plus lead-owned integration |
| Resumable events across reconnects | Partial: sync-events replays persisted entries | No: live events carry no IDs and reconnects replay nothing | Snapshot-plus-tail resume with Last-Event-ID |
| SDK (connect, createAgencyClient) | Yes | Yes: wraps run_turn, cancel_turn, and providers_list with event subscription | Types generated from the versioned event catalog |
| At-handle routing (parseHandles) | Yes | Yes: lone mentions rewrite provider, model, and effort inline | Selection model with escalation never a user choice |
| Compaction (0.9 trigger, 0.7 target, 20K cap) | Yes | Partial: client-side via runSessionTurn and needsCompaction; the daemon never passes onContextOverflow | Item-aware agent windows plus cache-event accounting |
| OAuth (PKCE plus device flow) | Yes | Blocked: all shipped client IDs are placeholders rejected by assertClientIdConfigured | Same flows once the user registers an app |
| Scheduler multi-key rotation (scheduleWithKeys) | Yes, with tests | No | Model ladder escalation across families |
| Progress checklist store | Yes, with tests | No runtime consumer | Progress file as the board substrate |
| Session projector (SessionProjector) | Yes, with tests | No runtime consumer | Single projection behind session reads |
| dispatch_compare via spawnParallel | Yes | Yes: the only production caller of spawnParallel | Lateral delegation replacing fan-out |
| checkDepthGate | Yes | Yes: called by the dispatch tool | Flat team with no depth counter |
