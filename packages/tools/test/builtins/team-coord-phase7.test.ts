import { describe, expect, it } from "bun:test";
import {
  type CoordDeps,
  createCoordTools,
  type DelegateInputs,
  type FactsLike,
} from "../../src/builtins/team-coord.ts";
import type { ToolContext } from "../../src/contract.ts";

function ctxFor(handle: string): ToolContext {
  return { signal: new AbortController().signal, agentHandle: handle };
}

const coderFacts: FactsLike = {
  handle: "coder",
  capabilities: ["write-code"],
  tools: ["write", "read"],
  priceIndex: 10,
  inFlight: 0,
};

const explorerFacts: FactsLike = {
  handle: "explorer",
  capabilities: ["survey"],
  tools: ["read"],
  priceIndex: 1,
  inFlight: 0,
};

interface FakeState {
  items: Array<{ id: string; content: string; claimedBy?: string; filedBy?: string }>;
  sent: Array<{ kind: string; from: string; to?: string; text: string }>;
  posts: Array<{ seq: number; by: string; text: string }>;
  choices: Array<{ id: string; topic: string; text: string; by: string; status: string }>;
  spans: Record<
    string,
    Array<{
      step: number;
      tool: string;
      target: string;
      ok: boolean;
      durationMs: number;
      tokens: number;
      costUsd: number;
      input?: string;
      output?: string;
      thinking?: string;
    }>
  >;
  leadOnly: boolean;
}

function depsFor(state: FakeState, handle: string, allowed: (tool: string) => boolean): CoordDeps {
  return {
    board: {
      list: () => state.items.map((i) => ({ ...i, status: "pending" })),
      record: () => {},
    },
    inbox: {
      send: (msg) => {
        if (msg.kind === "ask" && !msg.to) return { ok: false, reason: "ask names one recipient" };
        if (!msg.to && msg.from !== "lead") return { ok: false, reason: "broadcast is lead-only" };
        if (state.sent.filter((s) => s.from === msg.from).length >= 5) {
          return { ok: false, reason: "budget exceeded" };
        }
        state.sent.push({
          kind: msg.kind,
          from: msg.from,
          ...(msg.to ? { to: msg.to } : {}),
          text: msg.text,
        });
        return { ok: true, message: { id: `m-${state.sent.length}` } };
      },
    },
    channel: {
      read: (since = 0, limit = 100) => {
        const posts = state.posts.filter((p) => p.seq > since).slice(0, limit);
        return { posts, cursor: posts.length > 0 ? (posts[posts.length - 1]?.seq ?? since) : since };
      },
    },
    choices: {
      digest: () => state.choices.map((c) => `${c.id} ${c.text} by @${c.by} ${c.status}`),
      propose: (topic, text, by, _rationale) => {
        const clash = state.choices.find((c) => c.topic === topic && c.text !== text);
        const entry = {
          id: `D-${state.choices.length + 1}`,
          topic,
          text,
          by,
          status: clash ? "routed" : "open",
        };
        state.choices.push(entry);
        return { entry, routed: clash !== undefined };
      },
      accept: (id, by) => {
        const entry = state.choices.find((c) => c.id === id);
        if (!entry) return { ok: false, reason: "unknown" };
        if (entry.status === "routed" && by !== "lead") return { ok: false, reason: "lead only" };
        entry.status = "accepted";
        return { ok: true };
      },
      list: () => state.choices.map((c) => ({ text: c.text, proposedBy: c.by, rationale: "" })),
    },
    resolveFiler: (ctx) => {
      const name = String((ctx as unknown as { agentHandle?: string }).agentHandle ?? handle);
      return { handle: name, isLead: name === "lead" };
    },
    factsOf: (h) => (h === "coder" ? coderFacts : h === "explorer" ? explorerFacts : undefined),
    allFacts: () => [coderFacts, explorerFacts],
    grantsOf: () => ({}),
    decide: (facts, req: DelegateInputs, all) => {
      const target = req.to
        ? all.find((a) => a.handle === req.to)
        : all.find((a) => a.handle !== facts.handle);
      if (!target) return { delegate: false, reason: "no match" };
      if (facts.capabilities.includes("write-code") && req.needs?.includes("write-code")) {
        return { delegate: false, reason: "self can do it" };
      }
      return { delegate: true, handle: target.handle, reason: "routed" };
    },
    fileDelegated: (filedBy, req, _target) => {
      const id = `item-${state.items.length + 1}`;
      state.items.push({ id, content: req.brief ?? "", filedBy });
      return { ok: true, id };
    },
    buildReport: (outcome) => ({
      goal: "g",
      outcome,
      itemsCompleted: [],
      itemsUnresolved: [],
      decisions: [],
      openQuestions: [],
      cost: { totalUsd: 0, perAgent: {}, tokens: 0, cacheHitRate: 0 },
    }),
    spansOf: (h) => state.spans[h] ?? [],
    itemsOf: (h) => state.items.filter((i) => i.claimedBy === h || i.filedBy === h).map((i) => i.id),
    mayInspect: (args) => {
      if (args.isLead || args.requester === args.targetHandle) return true;
      return args.targetItems.some((item) => args.sharedItems.includes(item));
    },
    timeline: (spans, filter) => {
      let rows = spans.filter((s) => (filter.since === undefined ? true : s.step > filter.since));
      if (filter.where === "errors") rows = rows.filter((s) => !s.ok);
      if (filter.where === "writes") rows = rows.filter((s) => s.tool === "write");
      return rows.slice(0, filter.limit ?? 100).map((s) => `#${s.step} ${s.tool} ${s.ok ? "ok" : "err"}`);
    },
    stepDetail: (spans, step) => {
      const span = spans.find((s) => s.step === step);
      if (!span) return undefined;
      return {
        step: span.step,
        tool: span.tool,
        input: span.input ?? "",
        output: span.output ?? "",
        thinking: span.thinking ?? "",
      };
    },
    reasoning: (spans, from, to) =>
      spans
        .filter((s) => s.step >= from && s.step <= to && s.thinking)
        .map((s) => s.thinking ?? "")
        .join("\n"),
    inspectCharge: 0.0001,
    inspectTokens: (text) => Math.ceil(text.length / 4),
    allowed,
  };
}

function freshState(): FakeState {
  return { items: [], sent: [], posts: [], choices: [], spans: {}, leadOnly: true };
}

describe("phase7 coord tools", () => {
  it("delegate files an addressed item and stays inline when self-doable", async () => {
    const state = freshState();
    const tools = createCoordTools(depsFor(state, "explorer", () => true));
    const delegate = tools.find((t) => t.name === "delegate");
    expect(delegate).toBeDefined();
    const out = await delegate?.handler({ brief: "Build the form", needs: ["survey"] }, ctxFor("explorer"));
    expect(out?.isError).toBeFalsy();
    expect(out?.content).toContain("coder");
    expect(state.items).toHaveLength(1);
    const selfTools = createCoordTools(depsFor(state, "coder", () => true));
    const selfDelegate = selfTools.find((t) => t.name === "delegate");
    const inline = await selfDelegate?.handler({ brief: "Fix it", needs: ["write-code"] }, ctxFor("coder"));
    expect(inline?.content).toContain("inline:");
    expect(state.items).toHaveLength(1);
  });

  it("inbox_send types, budgets, and gates broadcast to the lead", async () => {
    const state = freshState();
    const tools = createCoordTools(depsFor(state, "explorer", () => true));
    const send = tools.find((t) => t.name === "inbox_send");
    const askOpen = await send?.handler({ kind: "ask", text: "help?" }, ctxFor("explorer"));
    expect(askOpen?.isError).toBe(true);
    const peerCast = await send?.handler({ kind: "notify", text: "hi all" }, ctxFor("explorer"));
    expect(peerCast?.isError).toBe(true);
    const leadCast = await send?.handler({ kind: "notify", text: "hi all" }, ctxFor("lead"));
    expect(leadCast?.isError).toBeFalsy();
    const directed = await send?.handler({ kind: "answer", to: "coder", text: "here" }, ctxFor("explorer"));
    expect(directed?.content).toContain("sent m-");
  });

  it("channel_read pulls from a cursor", async () => {
    const state = freshState();
    state.posts = [
      { seq: 1, by: "lead", text: "goal" },
      { seq: 2, by: "coder", text: "claimed" },
    ];
    const tools = createCoordTools(depsFor(state, "coder", () => true));
    const read = tools.find((t) => t.name === "channel_read");
    const first = await read?.handler({ since: 0 }, ctxFor("coder"));
    expect(first?.content).toContain("cursor 2");
    const second = await read?.handler({ since: 2 }, ctxFor("coder"));
    expect(second?.content).toContain("no new posts");
  });

  it("decisions propose, route, and accept through the lead", async () => {
    const state = freshState();
    const tools = createCoordTools(depsFor(state, "coder", () => true));
    const decisions = tools.find((t) => t.name === "decisions");
    const first = await decisions?.handler(
      { move: "propose", topic: "schema", text: "use zod" },
      ctxFor("coder"),
    );
    expect(first?.content).toContain("proposed");
    const second = await decisions?.handler(
      { move: "propose", topic: "schema", text: "use yup" },
      ctxFor("reviewer"),
    );
    expect(second?.content).toContain("routed to lead");
    const read = await decisions?.handler({ move: "read" }, ctxFor("coder"));
    expect(read?.content).toContain("D-1");
  });

  it("agent_inspect is lead-gated, permissioned, and charged", async () => {
    const state = freshState();
    state.spans.coder = [
      {
        step: 1,
        tool: "read",
        target: "a.ts",
        ok: true,
        durationMs: 5,
        tokens: 10,
        costUsd: 0.001,
        input: "in",
        output: "out",
        thinking: "plan",
      },
      {
        step: 2,
        tool: "write",
        target: "b.ts",
        ok: false,
        durationMs: 9,
        tokens: 12,
        costUsd: 0.002,
        input: "in2",
        output: "out2",
        thinking: "fix",
      },
    ];
    state.items = [{ id: "item-9", content: "solo", filedBy: "coder", claimedBy: "coder" }];
    const peerTools = createCoordTools(depsFor(state, "reviewer", (tool) => tool !== "agent_inspect"));
    const peerInspect = peerTools.find((t) => t.name === "agent_inspect");
    const refused = await peerInspect?.handler(
      { handle: "coder", granularity: "timeline" },
      ctxFor("reviewer"),
    );
    expect(refused?.isError).toBe(true);
    const leadTools = createCoordTools(depsFor(state, "lead", () => true));
    const leadInspect = leadTools.find((t) => t.name === "agent_inspect");
    const timeline = await leadInspect?.handler({ handle: "coder", granularity: "timeline" }, ctxFor("lead"));
    expect(timeline?.content).toContain("#1 read ok");
    expect(timeline?.content).toContain("[charged $0.0001");
    const step = await leadInspect?.handler(
      { handle: "coder", granularity: "step", step: 2 },
      ctxFor("lead"),
    );
    expect(step?.content).toContain("input: in2");
    expect(step?.content).toContain("thinking: fix");
  });

  it("report_get renders a structured report with no transcripts", async () => {
    const state = freshState();
    const tools = createCoordTools(depsFor(state, "lead", () => true));
    const report = tools.find((t) => t.name === "report_get");
    const out = await report?.handler({ outcome: "complete" }, ctxFor("lead"));
    expect(out?.isError).toBeFalsy();
    const parsed = JSON.parse(String(out?.content));
    expect(parsed.goal).toBe("g");
    expect(JSON.stringify(parsed)).not.toContain("transcript");
  });
});
