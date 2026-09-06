# Orchestration

Target design from Part 7 of the plan: one lead opens a team, the team
delegates amongst itself and reports back, the lead reports to the user.
Every other harness is a tree of subprocesses; this is a flat team of
specialists coordinating on a shared board. This document captures
sections 7.0, 7.0.1, 7.0.2, and 7.4 only. Vocabulary, selection details,
and later sections stay in the plan until they are built.

## 7.0 The boundary protocol

The top-level contract is two crossings:

```
user to lead: goal
lead to team: goal plus acceptance criteria plus budget (one write)
team: plans, files, claims, delegates, reviews, completes (opaque)
team to lead: one structured report (one read)
lead to user: integration outcome plus judgment
```

The lead states the goal and the bar; the team's planner decomposes. The
team is context-isolated from the lead: the lead's context holds the
user goal, the report, and the integration outcome, never team
transcripts, tool output, or intermediate reasoning. The lead watches
lifecycle events, not the full stream; the full stream goes to the UI.

## 7.0.1 The report (the only thing that crosses back)

One structured object, not prose: goal, outcome (complete, halted,
over-budget, needs-user), items completed (item, files touched,
verification, by agent, cost), items unresolved (item, reason, last
attempt by), decisions (decision, proposed by, rationale), open questions
only the user can answer, and cost (total, per agent, tokens, cache hit
rate). The lead renders it with its own judgment. It is small enough to
survive compaction intact.

## 7.0.2 Three window types

Context is three windows with different owners, budgets, lifetimes, and
compaction rules:

Main (owner: lead) holds user turns, lead replies, reports, and
integration outcomes, and never team internals, tool output, or agent
reasoning. It lives for the whole conversation and compacts at the
standard 0.9/0.7 ratio.

Team (owner: the team) holds board transitions, delegations, decisions,
agent-to-agent messages, and user posts to the team, and never file
contents, tool output, or agent reasoning. It lives for one run and
folds into decisions plus board state, which are already structured, so
compaction is near-lossless.

Agent (owner: one agent, one item) holds the role prompt, item contract,
briefing, and its own tool calls and results, and never other agents'
transcripts or the full team chat. It lives for one item: live context
is released on close, the record persists. It compacts item-aware,
preserving the contract, acceptance criteria, decisions, files touched,
verification results, and open questions verbatim while summarizing
exploration and dead ends. This generalizes the todo exemption already
in sessions/compaction.ts from todos to item state. A second compaction
on the same item is a scoping signal: the agent considers counter or
escalate, and the team records it on the board.

No model ever reads the team window in full. Agents read a bounded
digest, the lead reads the report, the human reads all of it.

## 7.4 The board is the delegation ledger

The shared todo store becomes the coordination substrate. It already has
the right semantics in `OrchestraTodoStore`: four statuses, claimed-by,
exclusive claim, release restricted to the claimant, and a claimant that
cannot close its own item.

Messages are for questions; work is the board. Any agent may file an
item. Every delegation is then durable, ordered, inspectable, and
replayable; the human sees delegation history as state rather than
scrollback; work-stealing works when one specialist is loaded; ping-pong
is structurally impossible because delegation is a state transition, not
a conversation. This is the blackboard architecture: knowledge sources
watch a shared board and contribute opportunistically.
