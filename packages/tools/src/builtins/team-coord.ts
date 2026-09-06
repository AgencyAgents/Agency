import type { ToolContext, ToolSpec } from "../contract.ts";

export interface FactsLike {
  handle: string;
  capabilities: string[];
  tools: readonly string[] | "*";
  priceIndex: number;
  inFlight: number;
}

export interface DelegateInputs {
  to?: string;
  needs?: string[];
  brief: string;
  acceptanceCriteria?: string;
  briefing?: string;
  pathScope?: string[];
  budgetUsd?: number;
  budgetTurns?: number;
  tools?: string[];
  parallelizable?: boolean;
}

export interface GrantsLike {
  pathScope?: readonly string[] | "*";
  tools?: readonly string[] | "*";
}

export interface BoardItemLikeShim {
  id: string;
  content: string;
  status: string;
  claimedBy?: string;
  filedBy?: string;
}

export interface SpanLike {
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
}

export interface InboxSendLike {
  kind: "ask" | "answer" | "notify" | "handoff" | "blocked" | "delegate";
  from: string;
  to?: string;
  text: string;
}

export interface CoordDeps {
  board: {
    list(): BoardItemLikeShim[];
    record(itemId: string, by: string, move: string, detail?: string): void;
  };
  inbox: {
    send(msg: InboxSendLike): { ok: true; message: { id: string } } | { ok: false; reason: string };
  };
  channel: {
    read(
      since?: number,
      limit?: number,
    ): { posts: Array<{ seq: number; by: string; text: string }>; cursor: number };
  };
  choices: {
    digest(): string[];
    propose(
      topic: string,
      text: string,
      by: string,
      rationale?: string,
    ): { entry: { id: string }; routed: boolean };
    accept(id: string, by: string): { ok: boolean; reason?: string };
    list(): Array<{ text: string; proposedBy: string; rationale: string }>;
  };
  resolveFiler: (ctx: ToolContext) => { handle: string; isLead: boolean };
  factsOf: (handle: string) => FactsLike | undefined;
  allFacts: () => FactsLike[];
  grantsOf: (handle: string) => GrantsLike;
  decide: (
    facts: FactsLike,
    req: DelegateInputs,
    all: FactsLike[],
  ) => { delegate: boolean; handle?: string; reason: string };
  fileDelegated: (
    filedBy: string,
    req: DelegateInputs,
    handle: string,
    grants: GrantsLike,
  ) => { ok: boolean; id?: string; reason?: string };
  buildReport: (outcome: string) => unknown;
  spansOf: (handle: string) => SpanLike[];
  itemsOf: (handle: string) => string[];
  mayInspect: (args: {
    requester: string;
    isLead: boolean;
    targetHandle: string;
    sharedItems: readonly string[];
    targetItems: readonly string[];
  }) => boolean;
  timeline: (spans: SpanLike[], filter: { since?: number; limit?: number; where?: string }) => string[];
  stepDetail: (
    spans: SpanLike[],
    step: number,
  ) => { step: number; tool: string; input: string; output: string; thinking: string } | undefined;
  reasoning: (spans: SpanLike[], from: number, to: number) => string;
  inspectCharge: number;
  inspectTokens: (text: string) => number;
  allowed: (tool: string) => boolean;
}

function denied(tool: string): { content: string; isError: boolean } {
  return { content: `${tool} is not permitted for this agent`, isError: true };
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function strList(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || !value.every((v) => typeof v === "string")) return undefined;
  return [...value];
}

function num(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

export function createDelegateTool(deps: CoordDeps): ToolSpec {
  const spec: ToolSpec = {
    name: "delegate",
    description: "Asks a teammate to take work; files a lasting board item for them.",
    inputSchema: {
      type: "object",
      properties: {
        to: { type: "string" },
        needs: { type: "array", items: { type: "string" } },
        brief: { type: "string" },
        acceptanceCriteria: { type: "string" },
        briefing: { type: "string" },
        pathScope: { type: "array", items: { type: "string" } },
        budgetUsd: { type: "number" },
        budgetTurns: { type: "number" },
        tools: { type: "array", items: { type: "string" } },
        parallelizable: { type: "boolean" },
      },
      required: ["brief"],
    },
    riskTier: "moderate",
    renderCall: (input) => `delegate ${str(input.to ?? input.needs ?? "")}`,
    renderResult: (result) => (result.isError ? `delegate failed: ${result.content}` : result.content),
    async handler(input, ctx) {
      if (!deps.allowed("delegate")) return denied("delegate");
      const filer = deps.resolveFiler(ctx);
      const facts = deps.factsOf(filer.handle);
      if (!facts) return { content: `unknown handle: ${filer.handle}`, isError: true };
      const brief = str(input.brief);
      if (brief.trim().length === 0) return { content: "delegate requires brief", isError: true };
      const req: DelegateInputs = { brief };
      const to = str(input.to);
      if (to.length > 0) req.to = to;
      const needs = strList(input.needs);
      if (needs) req.needs = needs;
      const criteria = str(input.acceptanceCriteria);
      if (criteria.length > 0) req.acceptanceCriteria = criteria;
      const briefing = str(input.briefing);
      if (briefing.length > 0) req.briefing = briefing;
      const scope = strList(input.pathScope);
      if (scope) req.pathScope = scope;
      const budgetUsd = num(input.budgetUsd);
      if (budgetUsd !== undefined) req.budgetUsd = budgetUsd;
      const budgetTurns = num(input.budgetTurns);
      if (budgetTurns !== undefined) req.budgetTurns = budgetTurns;
      const tools = strList(input.tools);
      if (tools) req.tools = tools;
      if (input.parallelizable === true) req.parallelizable = true;
      const verdict = deps.decide(facts, req, deps.allFacts());
      if (!verdict.delegate || !verdict.handle) return { content: `inline: ${verdict.reason}` };
      const filed = deps.fileDelegated(filer.handle, req, verdict.handle, deps.grantsOf(filer.handle));
      if (!filed.ok || !filed.id) return { content: filed.reason ?? "file failed", isError: true };
      return { content: `delegated to ${verdict.handle} as ${filed.id}: ${verdict.reason}` };
    },
  };
  return spec;
}

const INBOX_KIND_SET = new Set(["ask", "answer", "notify", "handoff", "blocked", "delegate"]);

export function createInboxSendTool(deps: CoordDeps): ToolSpec {
  const spec: ToolSpec = {
    name: "inbox_send",
    description: "Posts a typed note to one teammate inbox, or to all when sent by the lead.",
    inputSchema: {
      type: "object",
      properties: {
        kind: { type: "string", enum: ["ask", "answer", "notify", "handoff", "blocked", "delegate"] },
        to: { type: "string" },
        text: { type: "string" },
      },
      required: ["kind", "text"],
    },
    riskTier: "moderate",
    renderCall: (input) => `inbox_send ${str(input.kind)}`,
    renderResult: (result) => (result.isError ? `inbox_send failed: ${result.content}` : result.content),
    async handler(input, ctx) {
      if (!deps.allowed("inbox_send")) return denied("inbox_send");
      const filer = deps.resolveFiler(ctx);
      const kind = str(input.kind);
      if (!INBOX_KIND_SET.has(kind)) return { content: `unknown kind: ${kind}`, isError: true };
      const text = str(input.text);
      if (text.trim().length === 0) return { content: "inbox_send requires text", isError: true };
      const to = str(input.to);
      const outcome = deps.inbox.send({
        kind: kind as InboxSendLike["kind"],
        from: filer.handle,
        ...(to.length > 0 ? { to } : {}),
        text,
      });
      if (!outcome.ok) return { content: outcome.reason, isError: true };
      return { content: `sent ${outcome.message.id}` };
    },
  };
  return spec;
}

export function createChannelReadTool(deps: CoordDeps): ToolSpec {
  const spec: ToolSpec = {
    name: "channel_read",
    description: "Pulls shared channel posts after a cursor; never pushes into prompts.",
    inputSchema: {
      type: "object",
      properties: { since: { type: "number" }, limit: { type: "number" } },
    },
    riskTier: "safe",
    renderCall: (input) => `channel_read ${String(input.since ?? 0)}`,
    renderResult: (result) => (result.isError ? `channel_read failed: ${result.content}` : result.content),
    async handler(input, _ctx) {
      if (!deps.allowed("channel_read")) return denied("channel_read");
      const since = num(input.since) ?? 0;
      const limit = num(input.limit) ?? 100;
      const { posts, cursor } = deps.channel.read(since, limit);
      if (posts.length === 0) return { content: `cursor ${cursor}: no new posts` };
      const lines = posts.map((p) => `#${p.seq} @${p.by}: ${p.text}`);
      return { content: `cursor ${cursor}\n${lines.join("\n")}` };
    },
  };
  return spec;
}

export function createDecisionsTool(deps: CoordDeps): ToolSpec {
  const spec: ToolSpec = {
    name: "decisions",
    description: "Reads the shared choice log, proposes entries, or accepts them.",
    inputSchema: {
      type: "object",
      properties: {
        move: { type: "string", enum: ["read", "propose", "accept"] },
        topic: { type: "string" },
        text: { type: "string" },
        rationale: { type: "string" },
        id: { type: "string" },
      },
      required: ["move"],
    },
    riskTier: "moderate",
    renderCall: (input) => `decisions ${str(input.move)}`,
    renderResult: (result) => (result.isError ? `decisions failed: ${result.content}` : result.content),
    async handler(input, ctx) {
      if (!deps.allowed("decisions")) return denied("decisions");
      const filer = deps.resolveFiler(ctx);
      const move = str(input.move);
      if (move === "read") {
        const lines = deps.choices.digest();
        return { content: lines.length > 0 ? lines.join("\n") : "no choices yet" };
      }
      if (move === "propose") {
        const topic = str(input.topic);
        const text = str(input.text);
        if (topic.trim().length === 0 || text.trim().length === 0) {
          return { content: "propose requires topic and text", isError: true };
        }
        try {
          const { entry, routed } = deps.choices.propose(topic, text, filer.handle, str(input.rationale));
          return { content: routed ? `${entry.id} routed to lead` : `${entry.id} proposed` };
        } catch (error: unknown) {
          return { content: error instanceof Error ? error.message : String(error), isError: true };
        }
      }
      if (move === "accept") {
        const id = str(input.id);
        if (id.length === 0) return { content: "accept requires id", isError: true };
        const outcome = deps.choices.accept(id, filer.isLead ? "lead" : filer.handle);
        return outcome.ok
          ? { content: `${id} accepted` }
          : { content: outcome.reason ?? "failed", isError: true };
      }
      return { content: `unknown move: ${move}`, isError: true };
    },
  };
  return spec;
}

export function createAgentInspectTool(deps: CoordDeps): ToolSpec {
  const spec: ToolSpec = {
    name: "agent_inspect",
    description: "Looks up what a team agent did at timeline, step, or reasoning detail.",
    inputSchema: {
      type: "object",
      properties: {
        handle: { type: "string" },
        granularity: { type: "string", enum: ["timeline", "step", "reasoning"] },
        step: { type: "number" },
        since: { type: "number" },
        limit: { type: "number" },
        where: { type: "string", enum: ["errors", "writes"] },
      },
      required: ["handle", "granularity"],
    },
    riskTier: "safe",
    renderCall: (input) => `agent_inspect ${str(input.handle)} ${str(input.granularity)}`,
    renderResult: (result) => (result.isError ? `agent_inspect failed: ${result.content}` : result.content),
    async handler(input, ctx) {
      if (!deps.allowed("agent_inspect")) return denied("agent_inspect");
      const filer = deps.resolveFiler(ctx);
      const handle = str(input.handle);
      const granularity = str(input.granularity);
      if (handle.length === 0) return { content: "agent_inspect requires handle", isError: true };
      const shared = deps.itemsOf(filer.handle);
      const targetItems = deps.itemsOf(handle);
      if (
        !deps.mayInspect({
          requester: filer.handle,
          isLead: filer.isLead,
          targetHandle: handle,
          sharedItems: shared,
          targetItems,
        })
      ) {
        return { content: `${filer.handle} may not inspect ${handle}`, isError: true };
      }
      const spans = deps.spansOf(handle);
      if (granularity === "timeline") {
        const filter: { since?: number; limit?: number; where?: string } = {};
        const since = num(input.since);
        if (since !== undefined) filter.since = since;
        const limit = num(input.limit);
        if (limit !== undefined) filter.limit = limit;
        const where = str(input.where);
        if (where === "errors" || where === "writes") filter.where = where;
        const lines = deps.timeline(spans, filter);
        const tokens = deps.inspectTokens(lines.join("\n"));
        return { content: `${lines.join("\n")}\n[charged $${deps.inspectCharge} ${tokens}t]` };
      }
      if (granularity === "step") {
        const step = num(input.step);
        if (step === undefined) return { content: "step requires a step number", isError: true };
        const detail = deps.stepDetail(spans, step);
        if (!detail) return { content: `no step ${step} for ${handle}`, isError: true };
        return {
          content: `step ${detail.step} ${detail.tool}\ninput: ${detail.input}\noutput: ${detail.output}\nthinking: ${detail.thinking}\n[charged $${deps.inspectCharge}]`,
        };
      }
      if (granularity === "reasoning") {
        const since = num(input.since) ?? 1;
        const limit = num(input.limit) ?? spans.length;
        const text = deps.reasoning(spans, since, since + limit - 1);
        return { content: `${text}\n[charged $${deps.inspectCharge}]` };
      }
      return { content: `unknown granularity: ${granularity}`, isError: true };
    },
  };
  return spec;
}

export function createReportGetTool(deps: CoordDeps): ToolSpec {
  const spec: ToolSpec = {
    name: "report_get",
    description: "Renders the structured team report: outcome, items, choices, cost.",
    inputSchema: { type: "object", properties: { outcome: { type: "string" } } },
    riskTier: "safe",
    renderCall: () => "report_get",
    renderResult: (result) => (result.isError ? `report_get failed: ${result.content}` : result.content),
    async handler(input, _ctx) {
      if (!deps.allowed("report_get")) return denied("report_get");
      const report = deps.buildReport(str(input.outcome));
      return { content: JSON.stringify(report, null, 2) };
    },
  };
  return spec;
}

export function createCoordTools(deps: CoordDeps): ToolSpec[] {
  return [
    createDelegateTool(deps),
    createInboxSendTool(deps),
    createChannelReadTool(deps),
    createDecisionsTool(deps),
    createAgentInspectTool(deps),
    createReportGetTool(deps),
  ];
}
