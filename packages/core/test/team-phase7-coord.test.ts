import { describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseAgentFile } from "../src/agents/files.ts";
import { appendTeamProtocol, resolveFamilyPrompt } from "../src/prompt/compose.ts";
import { ChoiceLog } from "../src/team/choices.ts";
import { buildDigest, ChannelStore, DIGEST_LINE_BUDGET, InboxStore } from "../src/team/inbox.ts";
import {
  type AgentFacts,
  buildTeamReport,
  checkDelegation,
  demoteLeadTools,
  isTeamLive,
  materializeDelegate,
} from "../src/team/lateral.ts";
import {
  auditPromptToolOverlap,
  buildTeamPrompt,
  checkLayerBudgets,
  LAYER_BUDGETS,
  PLAYBOOK,
  resolveRolePrompt,
  type TeamPromptInput,
} from "../src/team/layers.ts";
import {
  canInspect,
  estimateTokens,
  inspectReasoning,
  inspectStep,
  inspectTimeline,
  redactInspectText,
  spansToInspectable,
} from "../src/team/review.ts";
import { BoardStore } from "../src/team/todo.ts";
import { TraceRecorder } from "../src/trace/recorder.ts";

const coderFacts: AgentFacts = {
  handle: "coder",
  capabilities: ["write-code", "edit"],
  tools: ["write", "edit", "read"],
  priceIndex: 10,
  inFlight: 0,
};

const explorerFacts: AgentFacts = {
  handle: "explorer",
  capabilities: ["survey"],
  tools: ["read", "grep"],
  priceIndex: 1,
  inFlight: 0,
};

const cheapCoderFacts: AgentFacts = {
  handle: "cheap-coder",
  capabilities: ["write-code", "edit"],
  tools: ["write", "edit", "read"],
  priceIndex: 5,
  inFlight: 0,
};

function promptInput(overrides: Partial<TeamPromptInput> = {}): TeamPromptInput {
  return {
    goal: "Ship the login form",
    roster: "coder explorer reviewer",
    ownersSummary: "src/auth/** @coder",
    workspaceTexts: ["Follow the repo style guide."],
    family: "anthropic",
    role: "coder",
    builtInRolePrompt: "Built-in coder prompt.",
    toolDescriptions: ["read: reads a file", "write: writes a file"],
    decisions: ["D-1 use zod by @coder accepted"],
    claimedItems: ["item-1 Build the form"],
    inbox: ["[from explorer] need the schema"],
    digest: ["board item-1 file by @lead"],
    environment: "date 2026-09-06",
    ...overrides,
  };
}

describe("phase7 lateral delegation", () => {
  it("delegate message files a durable item for the resolved handle", () => {
    const board = new BoardStore();
    const verdict = checkDelegation(explorerFacts, { needs: ["write-code"], brief: "Build the form" }, [
      coderFacts,
      explorerFacts,
    ]);
    expect(verdict.delegate).toBe(true);
    if (!verdict.delegate) return;
    expect(verdict.handle).toBe("coder");
    const filed = materializeDelegate(board, "explorer", { brief: "Build the form" }, verdict.handle);
    expect(filed.ok).toBe(true);
    const items = board.list();
    expect(items).toHaveLength(1);
    expect(items[0]?.content).toBe("Build the form");
    const moves = board.listEvents().map((e) => e.move);
    expect(moves).toContain("delegate:coder");
  });

  it("delegation check refuses work the requester can do inline", () => {
    const verdict = checkDelegation(coderFacts, { needs: ["edit"], brief: "Fix a typo" }, [
      coderFacts,
      explorerFacts,
    ]);
    expect(verdict).toEqual({ delegate: false, reason: expect.any(String) });
  });

  it("delegation check delegates on missing skill, busy parallel, or cheaper specialist", () => {
    const missing = checkDelegation(coderFacts, { needs: ["survey"], brief: "Map auth" }, [
      coderFacts,
      explorerFacts,
    ]);
    expect(missing).toMatchObject({ delegate: true, handle: "explorer" });
    const busy = checkDelegation(
      { ...coderFacts, inFlight: 2 },
      { needs: ["edit"], brief: "Fix two files", parallelizable: true },
      [coderFacts, cheapCoderFacts],
    );
    expect(busy.delegate).toBe(true);
    const cheaper = checkDelegation(coderFacts, { needs: ["write-code"], brief: "Add a test" }, [
      coderFacts,
      cheapCoderFacts,
    ]);
    expect(cheaper).toMatchObject({ delegate: true, handle: "cheap-coder" });
  });
});

describe("phase7 report crossing", () => {
  it("report carries no transcripts and the lead grows by the report alone", () => {
    const board = new BoardStore();
    const filed = board.file({ content: "Build the form" }, "lead");
    expect(filed.ok).toBe(true);
    const report = buildTeamReport({
      goal: "Ship the login form",
      outcome: "complete",
      items: board.list(),
      decisions: [],
      openQuestions: [],
      cost: {
        totalUsd: 0.5,
        perAgent: {},
        tokens: 100,
        cacheHitRate: 0,
        inputTokens: 80,
        outputTokens: 20,
        cachedInputTokens: 0,
        cacheWriteInputTokens: 0,
      },
      attempts: {},
    });
    const json = JSON.stringify(report);
    expect(json).not.toContain("transcript");
    expect(Object.keys(report).sort()).toEqual(
      ["cost", "decisions", "goal", "itemsCompleted", "itemsUnresolved", "openQuestions", "outcome"].sort(),
    );
    const before = JSON.stringify(["Ship the login form"]).length;
    const after = JSON.stringify(["Ship the login form", report]).length;
    expect(after - before).toBe(json.length + 1);
  });
});

describe("phase7 choice log", () => {
  it("conflicting proposals route to the lead and settle there", () => {
    const log = new ChoiceLog();
    const first = log.propose("validation", "use zod for all validation", "coder", "typed schemas");
    expect(first.routed).toBe(false);
    const second = log.propose("validation", "use yup for all validation", "reviewer", "smaller bundle");
    expect(second.routed).toBe(true);
    expect(second.entry.status).toBe("routed-to-lead");
    expect(log.routedToLead()).toHaveLength(1);
    const peerSettle = log.accept(second.entry.id, "reviewer");
    expect(peerSettle.ok).toBe(false);
    const leadSettle = log.accept(second.entry.id, "lead");
    expect(leadSettle.ok).toBe(true);
    expect(log.digest()).toHaveLength(2);
  });
});

describe("phase7 layered prompt", () => {
  it("carries role, protocol, goal, decisions, claimed; prefix is stable across tails", () => {
    const first = buildTeamPrompt(promptInput());
    const second = buildTeamPrompt(
      promptInput({ inbox: ["[from lead] new question"], digest: ["board item-2 file by @coder"] }),
    );
    expect(first.over).toEqual([]);
    expect(first.text).toContain(resolveFamilyPrompt("anthropic", "coder").slice(0, 24));
    expect(first.text).toContain(appendTeamProtocol("coder").trim().slice(0, 24));
    expect(first.text).toContain("Ship the login form");
    expect(first.text).toContain("D-1 use zod");
    expect(first.text).toContain("item-1 Build the form");
    expect(first.prefix).toBe(second.prefix);
    expect(first.text).not.toBe(second.text);
    expect(first.tail).not.toBe(second.tail);
  });

  it("layer budgets hold for a sample team prompt", () => {
    const prompt = buildTeamPrompt(promptInput());
    expect(checkLayerBudgets(prompt.layers)).toEqual([]);
    for (const layer of Object.keys(LAYER_BUDGETS)) {
      expect(LAYER_BUDGETS[layer as keyof typeof LAYER_BUDGETS]).toBeGreaterThan(0);
    }
  });

  it("playbook shares no long phrases with tool mechanics", () => {
    const tools = [
      "Asks a teammate to take work; files a lasting board item for them.",
      "Posts a typed note to one teammate inbox, or to all when sent by the lead.",
      "Pulls shared channel posts after a cursor; never pushes into prompts.",
    ];
    expect(auditPromptToolOverlap(PLAYBOOK, tools)).toEqual([]);
  });
});

describe("phase7 digest scaling", () => {
  it("tenfold channel growth leaves per-agent tail tokens flat", () => {
    const small = new ChannelStore();
    for (let i = 0; i < 10; i++) small.post("coder", `note ${i}`);
    const big = new ChannelStore();
    for (let i = 0; i < 100; i++) big.post("coder", `note ${i}`);
    const fresh = ["same new line one", "same new line two"];
    const smallTail = small.read(10);
    for (const line of fresh) small.post("coder", line);
    const bigTail = big.read(100);
    for (const line of fresh) big.post("coder", line);
    expect(smallTail.cursor).toBe(10);
    expect(bigTail.cursor).toBe(100);
    const smallDigest = buildDigest({
      events: [],
      posts: small.read(10).posts,
      decisions: [],
      lastSeenEvent: 0,
      lastSeenPost: 10,
    });
    const bigDigest = buildDigest({
      events: [],
      posts: big.read(100).posts,
      decisions: [],
      lastSeenEvent: 0,
      lastSeenPost: 100,
    });
    expect(smallDigest.lines).toEqual(bigDigest.lines);
    expect(estimateTokens(smallDigest.lines.join("\n"))).toBe(estimateTokens(bigDigest.lines.join("\n")));
  });

  it("digest caps at the line budget and renders board events deterministically", () => {
    const board = new BoardStore();
    for (let i = 0; i < 100; i++) {
      const filed = board.file({ content: `work ${i}` }, "lead");
      if (filed.ok) board.record(filed.item.id, "lead", "file");
    }
    const once = buildDigest({
      events: board.listEvents(),
      posts: [],
      decisions: [],
      lastSeenEvent: 0,
      lastSeenPost: 0,
    });
    const twice = buildDigest({
      events: board.listEvents(),
      posts: [],
      decisions: [],
      lastSeenEvent: 0,
      lastSeenPost: 0,
    });
    expect(once.lines).toEqual(twice.lines);
    expect(once.lines.length).toBeLessThanOrEqual(DIGEST_LINE_BUDGET);
    expect(once.lines[0]).toMatch(/^board /);
  });

  it("free text falls back to the cheap summarizer only when provided", () => {
    const channel = new ChannelStore();
    channel.post("coder", "a long free text note about the schema choice");
    const plain = buildDigest({
      events: [],
      posts: channel.read(0).posts,
      decisions: [],
      lastSeenEvent: 0,
      lastSeenPost: 0,
    });
    expect(plain.lines.join("\n")).toContain("free text note");
    let called = 0;
    const summarized = buildDigest({
      events: [],
      posts: channel.read(0).posts,
      decisions: [],
      lastSeenEvent: 0,
      lastSeenPost: 0,
      summarizeFreeText: (texts) => {
        called += 1;
        return `summary of ${texts.length} notes`;
      },
    });
    expect(called).toBe(1);
    expect(summarized.lines.join("\n")).toContain("summary of 1 notes");
  });
});

describe("phase7 inspection", () => {
  function fortySpans() {
    const dir = mkdtempSync(join(tmpdir(), "phase7-inspect-"));
    const recorder = new TraceRecorder({ sessionsDir: dir, sessionId: "s1", traceId: "t1" });
    for (let i = 1; i <= 40; i++) {
      const id = recorder.startToolSpan(null, { toolName: i % 5 === 0 ? "write" : "read" });
      recorder.endSpan(id, {
        attributes: {
          target: `src/file-${i}.ts`,
          input: `input payload for step ${i} `.repeat(20),
          output: `output payload for step ${i} `.repeat(20),
          thinking: `thinking before step ${i}: check the scope first`,
          inputTokens: 30,
          outputTokens: 20,
          cost: 0.0001,
        },
      });
    }
    return spansToInspectable(recorder.getSpans());
  }

  it("timeline on 40 steps fits a fixed token budget", () => {
    const spans = fortySpans();
    expect(spans).toHaveLength(40);
    const lines = inspectTimeline(spans);
    expect(lines).toHaveLength(40);
    expect(estimateTokens(lines.join("\n"))).toBeLessThan(1500);
    expect(lines[0]).toMatch(/^#1 read /);
  });

  it("step returns full input, output, and preceding thinking", () => {
    const spans = fortySpans();
    const detail = inspectStep(spans, 7);
    expect(detail?.tool).toBe("read");
    expect(detail?.input).toContain("input payload for step 7");
    expect(detail?.output).toContain("output payload for step 7");
    expect(detail?.thinking).toContain("thinking before step 7");
  });

  it("reasoning concatenates thinking across a span range under a cap", () => {
    const spans = fortySpans();
    const text = inspectReasoning(spans, 1, 5);
    expect(text).toContain("thinking before step 1");
    expect(text).toContain("thinking before step 5");
    expect(text).not.toContain("thinking before step 6");
  });

  it("peers inspect only shared items while the lead inspects all", () => {
    expect(
      canInspect({
        requester: "lead",
        isLead: true,
        targetHandle: "coder",
        sharedItems: [],
        targetItems: ["item-9"],
      }),
    ).toBe(true);
    expect(
      canInspect({
        requester: "reviewer",
        isLead: false,
        targetHandle: "coder",
        sharedItems: ["item-1"],
        targetItems: ["item-1"],
      }),
    ).toBe(true);
    expect(
      canInspect({
        requester: "reviewer",
        isLead: false,
        targetHandle: "coder",
        sharedItems: ["item-1"],
        targetItems: ["item-9"],
      }),
    ).toBe(false);
  });

  it("inspection redacts secrets before display", () => {
    const dirty = "key sk-abcdef1234567890 and token ghp_abcdefgh1234 plus sk-abcdef1234567890 again";
    const clean = redactInspectText(dirty, ["plus"]);
    expect(clean).not.toContain("sk-abcdef1234567890");
    expect(clean).not.toContain("ghp_abcdefgh1234");
    expect(clean).not.toContain("plus");
  });
});

describe("phase7 lead demotion", () => {
  it("lead keeps coordination tools only while a team is live", () => {
    const live = [{ status: "pending" }, { status: "completed" }];
    expect(isTeamLive(live)).toBe(true);
    expect(isTeamLive([{ status: "completed" }])).toBe(false);
    expect(demoteLeadTools(["write", "edit", "bash", "read", "delegate"], true)).toEqual([
      "read",
      "delegate",
    ]);
    expect(demoteLeadTools(["write", "edit", "bash", "read"], false)).toEqual([
      "write",
      "edit",
      "bash",
      "read",
    ]);
  });
});

describe("phase7 inbox and channel", () => {
  it("typed sends enforce kinds, budgets, and lead-only broadcast", () => {
    const inbox = new InboxStore(2);
    const noRecipient = inbox.send({ kind: "ask", from: "coder", text: "help?" });
    expect(noRecipient.ok).toBe(false);
    const peerBroadcast = inbox.send({ kind: "notify", from: "coder", text: "hello all" });
    expect(peerBroadcast.ok).toBe(false);
    const leadBroadcast = inbox.send({ kind: "notify", from: "lead", text: "hello all" });
    expect(leadBroadcast.ok).toBe(true);
    expect(inbox.send({ kind: "answer", from: "coder", to: "explorer", text: "one" }).ok).toBe(true);
    expect(inbox.send({ kind: "answer", from: "coder", to: "explorer", text: "two" }).ok).toBe(true);
    const over = inbox.send({ kind: "answer", from: "coder", to: "explorer", text: "three" });
    expect(over.ok).toBe(false);
    expect(inbox.take("explorer")).toHaveLength(2);
    expect(inbox.take("explorer")).toHaveLength(0);
  });

  it("channel reads from a cursor and never replays", () => {
    const channel = new ChannelStore();
    channel.post("lead", "goal set");
    channel.post("coder", "claimed item-1");
    channel.post("coder", "done item-1");
    const first = channel.read(0);
    expect(first.posts).toHaveLength(3);
    expect(first.cursor).toBe(3);
    const second = channel.read(first.cursor);
    expect(second.posts).toHaveLength(0);
    expect(second.cursor).toBe(3);
  });
});

describe("phase7 agent files", () => {
  it("bodies extend the built-in prompt unless replace is set", () => {
    const plain = parseAgentFile("---\nrole: coder\n---\nPrefer small diffs.\n", "coder.md");
    expect(plain.replace).toBeUndefined();
    const merged = resolveRolePrompt("Built-in coder prompt.", plain.systemPrompt, plain.replace ?? false);
    expect(merged).toContain("Built-in coder prompt.");
    expect(merged).toContain("Prefer small diffs.");
    const swapped = parseAgentFile("---\nrole: coder\nreplace: true\n---\nOnly this.\n", "coder.md");
    expect(swapped.replace).toBe(true);
    expect(resolveRolePrompt("Built-in coder prompt.", swapped.systemPrompt, true)).toBe("Only this.");
  });
});
