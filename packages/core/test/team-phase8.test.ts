import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FULL_CAPABILITIES } from "@agency/guard";
import { noFetchHttp } from "../../eval/src/replay.ts";
import { generateTitle } from "../src/sessions/titles.ts";
import {
  recordIntegrationCheckpoint,
  resolveScopeFiles,
  restoreIntegrationCheckpoint,
} from "../src/team/checkpoint.ts";
import { checkCaps, checkCompletion, completionReport, NoProgressTracker } from "../src/team/closure.ts";
import { compareClaim, openCompareItem, recordCompareVerdict } from "../src/team/compare.ts";
import { createTeamLimiter } from "../src/team/concurrency.ts";
import {
  fileObjection,
  fileRebuttal,
  needsTiebreak,
  recordTiebreak,
  selectTiebreaker,
} from "../src/team/dispute.ts";
import { areScopesDisjoint, decideEscalation, formatTeamAnnouncement } from "../src/team/escalation.ts";
import { integrateSequentially } from "../src/team/integration.ts";
import { climbLadder, ladderHopFor, resolveLadderChain, retryTarget } from "../src/team/ladder.ts";
import { diffDiagnostics, gateReadyForReview } from "../src/team/review-gate.ts";
import {
  defaultTeamComposition,
  providersWithCredentials,
  ROLE_PROVIDERS,
  resolveRosterProviders,
  TEAM_ROSTER_MAX,
} from "../src/team/roster.ts";
import { runChildTurn } from "../src/team/run-child-turn.ts";
import { BoardStore } from "../src/team/todo.ts";

const LEAD = "lead";

function file(board: BoardStore, id: string, scope: string): void {
  const filed = board.file({ id, content: `slice ${id}`, pathScope: [scope] }, LEAD);
  expect(filed.ok).toBe(true);
}

describe("phase 8 escalation trigger plus cost gate announcement", () => {
  it("a two-item plan stays solo", () => {
    const decision = decideEscalation({
      itemCount: 2,
      disjointScopes: true,
      planSteps: 2,
      explicitRequest: false,
    });
    expect(decision.openTeam).toBe(false);
  });

  it("a four-item disjoint plan opens a team", () => {
    const scopes = [["src/auth/**"], ["src/db/**"], ["src/api/**"], ["src/ui/**"]];
    expect(areScopesDisjoint(scopes)).toBe(true);
    const decision = decideEscalation({
      itemCount: 4,
      disjointScopes: true,
      planSteps: 4,
      explicitRequest: false,
    });
    expect(decision.openTeam).toBe(true);
  });

  it("overlapping scopes stay solo and a long plan still escalates", () => {
    expect(areScopesDisjoint([["src/auth/**"], ["src/auth/login.ts"]])).toBe(false);
    const solo = decideEscalation({
      itemCount: 2,
      disjointScopes: false,
      planSteps: 2,
      explicitRequest: false,
    });
    expect(solo.openTeam).toBe(false);
    const plan = decideEscalation({
      itemCount: 2,
      disjointScopes: false,
      planSteps: 5,
      explicitRequest: false,
    });
    expect(plan.openTeam).toBe(true);
    const explicit = decideEscalation({
      itemCount: 1,
      disjointScopes: false,
      planSteps: 1,
      explicitRequest: true,
    });
    expect(explicit.openTeam).toBe(true);
  });

  it("the pre-spawn announcement is one line with agents, reason, and cost", () => {
    const line = formatTeamAnnouncement({
      handles: ["coder", "code-reviewer", "explorer"],
      reason: "4 independent items with disjoint path scopes",
      estimate: { lowUsd: 0.12, highUsd: 0.48, agentCount: 3 },
    });
    expect(line.split("\n")).toHaveLength(1);
    expect(line).toContain("coder");
    expect(line).toContain("est $0.12-0.48");
  });
});

describe("phase 8 reviewer-first composition plus multi-provider roster", () => {
  it("caps the team at five with one writer", () => {
    const team = defaultTeamComposition({
      writers: ["coder"],
      reviewers: ["code-reviewer", "plan-reviewer", "explorer", "researcher", "extra"],
    });
    expect(team.writer).toBe("coder");
    expect(team.total).toBeLessThanOrEqual(TEAM_ROSTER_MAX);
    expect(team.total).toBe(5);
  });

  it("role providers span more than one vendor", () => {
    const vendors = new Set(Object.values(ROLE_PROVIDERS).map((r) => r.provider));
    expect(vendors.size).toBeGreaterThan(1);
  });

  it("resolves each role from available credentials, recording remaps", () => {
    const agents = {
      coder: { provider: "anthropic", model: "claude-sonnet-5" },
      reviewer: { provider: "openai", model: "gpt-5.2" },
    };
    const { agents: resolved, remapped } = resolveRosterProviders(agents, ["openai"]);
    expect(resolved.coder?.provider).toBe("openai");
    expect(resolved.reviewer?.provider).toBe("openai");
    expect(remapped).toEqual(["coder"]);
  });

  it("detects credentials from config keys and AGENCY env names", () => {
    const found = providersWithCredentials({
      configProviders: { anthropic: { apiKey: "k" } },
      env: { AGENCY_OPENAI_API_KEY: "k" } as NodeJS.ProcessEnv,
    });
    expect(found).toEqual(["anthropic", "openai"]);
  });
});

describe("phase 8 escalation ladder with failure notes", () => {
  it("an item bounced twice climbs two rungs and carries both notes", () => {
    const chain = resolveLadderChain({});
    expect(chain.length).toBeGreaterThan(2);
    const board = new BoardStore();
    file(board, "item-1", "src/auth/**");
    const start = board.list().find((i) => i.id === "item-1")!;
    const firstHop = ladderHopFor(start, chain);
    const afterFirstBounce = climbLadder(
      { ...start, provider: firstHop.provider },
      "bounce 1: auth check missed",
      chain,
    );
    expect(afterFirstBounce.ladderRung).toBe(1);
    const secondHop = ladderHopFor(afterFirstBounce, chain);
    const afterSecond = climbLadder(
      { ...afterFirstBounce, provider: secondHop.provider },
      "decline: needs db scope",
      chain,
    );
    expect(afterSecond.ladderRung).toBe(2);
    expect(afterSecond.failureNotes).toEqual(["bounce 1: auth check missed", "decline: needs db scope"]);
  });

  it("the chain orders cheap before strong", () => {
    const chain = resolveLadderChain({});
    expect(chain[0]).toEqual({ provider: "glm", model: "glm-7" });
    expect(chain[chain.length - 1]).toEqual({ provider: "anthropic", model: "claude-opus-5" });
  });

  it("a peer failing on provider A retries on provider B and lands completed", () => {
    const board = new BoardStore();
    file(board, "item-1", "src/db/**");
    expect(board.claim("coder", "item-1").ok).toBe(true);
    expect(board.failToPending("coder", "item-1", "provider A overloaded").ok).toBe(true);
    const item = board.list().find((i) => i.id === "item-1")!;
    expect(item.failureNotes).toEqual(["provider A overloaded"]);
    const chain = resolveLadderChain({});
    const target = retryTarget({ ...item, provider: chain[0]?.provider }, chain);
    expect(target).toBeDefined();
    expect(target?.provider).not.toBe(chain[0]?.provider);
    expect(board.claim("coder", "item-1").ok).toBe(true);
    expect(board.setStatus(LEAD, "item-1", "completed").ok).toBe(true);
    expect(board.list().find((i) => i.id === "item-1")?.status).toBe("completed");
  });
});

describe("phase 8 disagreement protocol plus cross-provider tiebreak", () => {
  function disputedBoard(): BoardStore {
    const board = new BoardStore();
    file(board, "item-1", "src/auth/**");
    return board;
  }

  it("an objection without evidence is refused", () => {
    const board = disputedBoard();
    expect(fileObjection(board, { itemId: "item-1", by: "reviewer", evidence: "  " }).ok).toBe(false);
  });

  it("an unresolved author disagreement settles by third-provider tiebreak on the board", () => {
    const board = disputedBoard();
    expect(
      fileObjection(board, { itemId: "item-1", by: "reviewer", evidence: "token refresh races logout" }).ok,
    ).toBe(true);
    expect(needsTiebreak(board, "item-1")).toBe(false);
    expect(
      fileRebuttal(board, { itemId: "item-1", by: "coder", evidence: "refresh holds the session lock" }).ok,
    ).toBe(true);
    expect(needsTiebreak(board, "item-1")).toBe(true);
    expect(fileRebuttal(board, { itemId: "item-1", by: "reviewer", evidence: "another round" }).ok).toBe(
      false,
    );
    const tiebreaker = selectTiebreaker({
      authorProvider: "anthropic",
      reviewerProvider: "openai",
      availableProviders: ["anthropic", "openai", "google"],
    });
    expect(tiebreaker).toBe("google");
    expect(
      recordTiebreak(board, {
        itemId: "item-1",
        by: "lead",
        winner: "coder",
        rationale: "lock ordering proof holds",
        tiebreaker: tiebreaker!,
      }).ok,
    ).toBe(true);
    const item = board.list().find((i) => i.id === "item-1")!;
    expect(item.verdict?.winner).toBe("coder");
    expect(item.verdict?.tiebreaker).toBe("google");
    expect(needsTiebreak(board, "item-1")).toBe(false);
  });
});

describe("phase 8 LSP board gate", () => {
  const error = { path: "src/auth/login.ts", severity: 1, message: "type error", line: 10, character: 2 };
  const warning = { path: "src/auth/login.ts", severity: 2, message: "unused var", line: 3, character: 0 };

  it("refuses ready_for_review with new diagnostics in scope", () => {
    const board = new BoardStore({
      reviewGate: (item) => gateReadyForReview({ item, diagnostics: [error] }),
    });
    file(board, "item-1", "src/auth/**");
    expect(board.claim("coder", "item-1").ok).toBe(true);
    const refused = board.setStatus("coder", "item-1", "ready_for_review", {
      filesTouched: ["src/auth/login.ts"],
      verificationRun: "bun test",
      decisions: [],
      openQuestions: [],
    });
    expect(refused.ok).toBe(false);
    expect(refused.reason).toContain("diagnostics");
  });

  it("passes outside scope, on warnings, and without a scope", () => {
    const scoped = { id: "a", content: "a", status: "pending" as const, pathScope: ["src/db/**"] };
    expect(gateReadyForReview({ item: scoped, diagnostics: [error] })).toBeUndefined();
    const same = { id: "b", content: "b", status: "pending" as const, pathScope: ["src/auth/**"] };
    expect(gateReadyForReview({ item: same, diagnostics: [warning] })).toBeUndefined();
    const bare = { id: "c", content: "c", status: "pending" as const };
    expect(gateReadyForReview({ item: bare, diagnostics: [error] })).toBeUndefined();
  });

  it("only new diagnostics block; pre-existing debt passes", () => {
    const item = { id: "a", content: "a", status: "pending" as const, pathScope: ["src/auth/**"] };
    expect(gateReadyForReview({ item, diagnostics: diffDiagnostics([error], [error]) })).toBeUndefined();
    expect(gateReadyForReview({ item, diagnostics: diffDiagnostics([], [error]) })).toContain("diagnostics");
  });
});

describe("phase 8 integration checkpoint plus whole-run undo", () => {
  it("undo restores the workspace after a four-worktree merge", async () => {
    const root = mkdtempSync(join(tmpdir(), "agency-phase8-undo-"));
    try {
      const files = ["a.ts", "b.ts", "c.ts", "d.ts"].map((name) => join(root, name));
      for (const [index, path] of files.entries()) {
        writeFileSync(path, `original ${String(index)}\n`);
      }
      const board = new BoardStore();
      files.forEach((path, index) => {
        file(board, `item-${String(index + 1)}`, "**");
        void path;
      });
      const targets = files.map((path, index) => ({
        itemId: `item-${String(index + 1)}`,
        path,
        branch: `agency/team/item-${String(index + 1)}`,
      }));
      const outcome = await integrateSequentially({
        board,
        leadHandle: LEAD,
        callerHandle: LEAD,
        targets,
        checkpointPaths: files,
        merge: async (target) => {
          writeFileSync(target.path, "merged work\n");
          return { ok: true };
        },
      });
      expect(outcome.merged).toHaveLength(4);
      expect(outcome.checkpoint).toBeDefined();
      for (const path of files) expect(readFileSync(path, "utf8")).toBe("merged work\n");
      const { restored } = restoreIntegrationCheckpoint(outcome.checkpoint!);
      expect(restored).toHaveLength(4);
      for (const [index, path] of files.entries()) {
        expect(readFileSync(path, "utf8")).toBe(`original ${String(index)}\n`);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("resolves scopes to existing files and restores created files by deletion", () => {
    const root = mkdtempSync(join(tmpdir(), "agency-phase8-scope-"));
    try {
      mkdirSync(join(root, "src", "auth"), { recursive: true });
      writeFileSync(join(root, "src", "auth", "login.ts"), "v1\n");
      const matched = resolveScopeFiles(root, ["src/auth/**"]);
      expect(matched).toHaveLength(1);
      const created = join(root, "src", "auth", "new.ts");
      const checkpoint = recordIntegrationCheckpoint([...matched, created]);
      writeFileSync(created, "new\n");
      writeFileSync(matched[0]!, "v2\n");
      restoreIntegrationCheckpoint(checkpoint);
      expect(readFileSync(matched[0]!, "utf8")).toBe("v1\n");
      expect(() => readFileSync(created, "utf8")).toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("phase 8 completion plus caps plus no-progress detector", () => {
  it("an item blocked on a user answer waits without tripping the detector", () => {
    const board = new BoardStore();
    file(board, "item-1", "src/auth/**");
    expect(board.escalate("coder", "item-1", "which schema?").ok).toBe(true);
    const tracker = new NoProgressTracker(3);
    for (let turn = 0; turn < 10; turn++) {
      expect(tracker.note(board.list())).toBe("waiting");
    }
    const completion = checkCompletion(board.list(), true);
    expect(completion.complete).toBe(true);
    expect(completion.outcome).toBe("needs-user");
    const report = completionReport({
      goal: "g",
      outcome: completion.outcome,
      items: board.list(),
      decisions: [],
      cost: {
        totalUsd: 0,
        perAgent: {},
        tokens: 0,
        cacheHitRate: 0,
        inputTokens: 0,
        outputTokens: 0,
        cachedInputTokens: 0,
        cacheWriteInputTokens: 0,
      },
      attempts: {},
    });
    expect(report.openQuestions).toEqual(["which schema?"]);
  });

  it("a stalled board halts and surfaces after the limit", () => {
    const board = new BoardStore();
    file(board, "item-1", "src/auth/**");
    const tracker = new NoProgressTracker(2);
    expect(tracker.note(board.list())).toBe("progress");
    expect(tracker.note(board.list())).toBe("progress");
    expect(tracker.note(board.list())).toBe("stalled");
    expect(checkCompletion(board.list(), true).complete).toBe(false);
  });

  it("caps halt over-budget runs", () => {
    const over = checkCaps({ costUsd: 5, wallMs: 1, maxCostUsd: 5 });
    expect(over.ok).toBe(false);
    if (!over.ok) expect(over.outcome).toBe("over-budget");
    const wall = checkCaps({ costUsd: 1, wallMs: 9, maxWallMs: 9 });
    expect(wall.ok).toBe(false);
    if (!wall.ok) expect(wall.outcome).toBe("halted");
    expect(checkCaps({ costUsd: 1, wallMs: 1 }).ok).toBe(true);
  });
});

describe("phase 8 team concurrency plus compare mode", () => {
  it("a full five-agent roster runs parallel while larger fan-outs queue", async () => {
    const limiter = createTeamLimiter();
    let live = 0;
    let peak = 0;
    await Promise.all(
      Array.from({ length: 9 }, () =>
        limiter.run(async () => {
          live += 1;
          peak = Math.max(peak, live);
          await new Promise((r) => setTimeout(r, 5));
          live -= 1;
        }),
      ),
    );
    expect(peak).toBe(5);
    expect(limiter.active()).toBe(0);
  });

  it("N agents compare-claim one item and the verdict is recorded", () => {
    const board = new BoardStore();
    const opened = openCompareItem(board, { prompt: "sort it", handles: ["a", "b", "c"], filedBy: LEAD });
    expect(opened.ok).toBe(true);
    if (!opened.ok) throw new Error("compare open failed");
    for (const handle of ["a", "b", "c"]) {
      expect(compareClaim(board, handle, opened.itemId).ok).toBe(true);
    }
    const item = board.list().find((i) => i.id === opened.itemId)!;
    expect(item.compareClaims).toEqual(["a", "b", "c"]);
    expect(
      recordCompareVerdict(board, {
        itemId: opened.itemId,
        by: LEAD,
        winner: "b",
        rationale: "fastest correct",
      }).ok,
    ).toBe(true);
    expect(board.list().find((i) => i.id === opened.itemId)?.verdict?.winner).toBe("b");
  });
});

describe("phase 8 cheap routing on the child-turn assembly plus titles", () => {
  it("a summary child turn routes cheap with a tag", async () => {
    const { Scheduler } = await import("@agency/providers");
    const outcome = await runChildTurn(
      { http: noFetchHttp(), createTraceRecorder: () => undefined },
      {
        adapter: {
          family: "eval-cassette",
          async *stream() {
            yield { type: "text_delta", text: "done" };
            yield {
              type: "message_stop",
              stopReason: "end_turn",
              usage: { inputTokens: 10, outputTokens: 5 },
            };
          },
        },
        scheduler: new Scheduler({ maxAttempts: 1 }),
        session: [{ role: "user", content: [{ type: "text", text: "summarize this" }] }],
        systemPrompt: "eval",
        tools: [],
        model: "primary/m",
        apiKey: "k",
        provider: "primary",
        identity: { type: "user" },
        capabilities: FULL_CAPABILITIES,
        toolPolicy: { check: async () => "allow" as const },
        turnId: "t1",
        sessionId: "s1",
        cwd: ".",
        taskDepth: 1,
        taskKind: "summary",
        cheapModel: "cheap/m",
      },
    );
    expect(outcome.error).toBeUndefined();
    const routed = outcome.events.find((e) => (e as { type?: string }).type === "model_route") as
      | { routed?: string; model?: string }
      | undefined;
    expect(routed?.routed).toBe("cheap");
    expect(routed?.model).toBe("cheap/m");
  });

  it("title generation routes through the cheap model when offered", async () => {
    let usedModel = "";
    const title = await generateTitle("please add login", {
      config: { small_model: "primary/main" } as never,
      http: noFetchHttp(),
      apiKey: "k",
      providerConfig: {},
      adapterFor: () => ({
        family: "fake",
        async *stream(params: { model: string }) {
          usedModel = params.model;
          yield { type: "text_delta", text: "Add login" };
        },
      }),
      cheapModel: "cheap/titles",
    });
    expect(title).toBe("Add login");
    expect(usedModel).toBe("cheap/titles");
  });
});
