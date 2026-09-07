import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  agentFileName,
  buildActivityGraph,
  canInspect,
  INBOX_KINDS,
  INSPECT_CHARGE_USD,
  inspectReasoning,
  inspectStep,
  inspectTimeline,
  isValidAgentHandle,
  loadOwnersFile,
  ownersForPath,
  parseAgentFile,
} from "@agency/core";
import { clampEffortForModel } from "@agency/providers";
import type { MethodHandler } from "@agency/rpc";
import { AgencyError, ErrorCode } from "@agency/schema";
import { teamRunUsage } from "../costing.ts";
import { agentsListPayload } from "../team-context.ts";
import type { DaemonContext } from "../types.ts";
import { buildReportPayload, spansForHandle } from "./coords.ts";

function fail(reason: string): never {
  throw new AgencyError(ErrorCode.INTERNAL, reason, { source: "team-surface" });
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function num(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

function strList(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || !value.every((v) => typeof v === "string")) return undefined;
  return [...value];
}

function filerHandleOf(rawParams: unknown, field: string): string {
  const handle = str((rawParams as Record<string, unknown>)[field]);
  return handle.length > 0 ? handle : "lead";
}

function filerGrants(
  ctx: DaemonContext,
  handle: string,
): {
  pathScope: readonly string[] | "*";
  tools: readonly string[] | "*";
  budgetUsd?: number;
} {
  const agentCfg = (
    ctx.config as unknown as { agents?: Record<string, { pathScope?: string[]; tools?: string[] }> }
  ).agents?.[handle];
  const perAgentUsd = (ctx.config as unknown as { budgets?: { perAgentUsd?: number } }).budgets?.perAgentUsd;
  return {
    pathScope: agentCfg?.pathScope ?? "*",
    tools: agentCfg?.tools ?? "*",
    ...(perAgentUsd === undefined ? {} : { budgetUsd: perAgentUsd }),
  };
}

function itemsOf(ctx: DaemonContext, handle: string): string[] {
  return ctx.boardStore
    .list()
    .filter((i) => i.claimedBy === handle || i.filedBy === handle)
    .map((i) => i.id);
}

export function registerTeamSurfaceHandlers(
  handlers: Record<string, MethodHandler>,
  ctx: DaemonContext,
): void {
  handlers.board_read = async () => ({ items: ctx.boardStore.list(), events: ctx.boardStore.listEvents() });

  handlers.board_claim = async (rawParams) => {
    const params = (rawParams ?? {}) as Record<string, unknown>;
    const handle = filerHandleOf(params, "handle");
    const id = str(params.id);
    const move = str(params.move);
    if (id.length === 0) fail("board_claim requires id");
    if (move === "accept") {
      const outcome = ctx.boardStore.claim(handle, id);
      if (!outcome.ok) fail(outcome.reason ?? "claim failed");
      return { id, move, handle };
    }
    if (move === "decline") {
      const reason = str(params.reason);
      if (reason.length === 0) fail("decline requires a reason");
      const outcome = ctx.boardStore.decline(handle, id, reason);
      if (!outcome.ok) fail(outcome.reason ?? "decline failed");
      return { id, move, handle };
    }
    if (move === "counter") {
      const content = str(params.content);
      if (content.trim().length === 0) fail("counter requires content");
      const scope = strList(params.pathScope);
      const budgetUsd = num(params.budgetUsd);
      const budgetTurns = num(params.budgetTurns);
      const outcome = ctx.boardStore.counter(
        handle,
        id,
        {
          content,
          ...(scope === undefined ? {} : { pathScope: scope }),
          ...(budgetUsd === undefined ? {} : { budgetUsd }),
          ...(budgetTurns === undefined ? {} : { budgetTurns }),
        },
        filerGrants(ctx, handle),
      );
      if (!outcome.ok) fail(outcome.reason);
      return { id, move, handle, item: (outcome as { ok: true; item: unknown }).item };
    }
    if (move === "escalate") {
      const question = str(params.question);
      if (question.length === 0) fail("escalate requires a question");
      const outcome = ctx.boardStore.escalate(handle, id, question);
      if (!outcome.ok) fail(outcome.reason ?? "escalate failed");
      return { id, move, handle };
    }
    fail(`unknown move: ${move}`);
  };

  handlers.task_file = async (rawParams) => {
    const params = (rawParams ?? {}) as Record<string, unknown>;
    const filedBy = filerHandleOf(params, "filedBy");
    const content = str(params.content);
    if (content.trim().length === 0) fail("task_file requires content");
    const scope = strList(params.pathScope);
    const tools = strList(params.tools);
    const budgetUsd = num(params.budgetUsd);
    const budgetTurns = num(params.budgetTurns);
    const outcome = ctx.boardStore.file(
      {
        content,
        ...(typeof params.acceptanceCriteria === "string"
          ? { acceptanceCriteria: params.acceptanceCriteria }
          : {}),
        ...(typeof params.briefing === "string" ? { briefing: params.briefing } : {}),
        ...(scope === undefined ? {} : { pathScope: scope }),
        ...(budgetUsd === undefined ? {} : { budgetUsd }),
        ...(budgetTurns === undefined ? {} : { budgetTurns }),
        ...(tools === undefined ? {} : { tools }),
      },
      filedBy,
      filerGrants(ctx, filedBy),
    );
    if (!outcome.ok) fail(outcome.reason);
    return { item: (outcome as { ok: true; item: unknown }).item };
  };

  handlers.inbox_send = async (rawParams) => {
    const params = (rawParams ?? {}) as Record<string, unknown>;
    const kind = str(params.kind);
    if (!(INBOX_KINDS as readonly string[]).includes(kind)) fail(`unknown kind: ${kind}`);
    const from = filerHandleOf(params, "from");
    const text = str(params.text);
    if (text.trim().length === 0) fail("inbox_send requires text");
    const to = str(params.to);
    const outcome = ctx.inboxStore.send({
      kind: kind as (typeof INBOX_KINDS)[number],
      from,
      ...(to.length > 0 ? { to } : {}),
      text,
    });
    if (!outcome.ok) fail(outcome.reason);
    return { message: (outcome as { ok: true; message: unknown }).message };
  };

  handlers.channel_read = async (rawParams) => {
    const params = (rawParams ?? {}) as Record<string, unknown>;
    return ctx.channelStore.read(num(params.since) ?? 0, num(params.limit) ?? 100);
  };

  handlers.owners_read = async (rawParams) => {
    const path = str((rawParams as Record<string, unknown>)?.path);
    if (path.length === 0) fail("owners_read requires path");
    return { path, handles: ownersForPath(loadOwnersFile(ctx.options.workspaceRoot), path) };
  };

  handlers.decisions_read = async () => ({ decisions: ctx.choiceLog.list() });

  handlers.report_get = async (rawParams) => {
    const outcome = str((rawParams as Record<string, unknown>)?.outcome);
    return buildReportPayload(ctx, outcome.length > 0 ? outcome : "complete");
  };

  handlers.agent_inspect = async (rawParams) => {
    const params = (rawParams ?? {}) as Record<string, unknown>;
    const handle = str(params.handle);
    const granularity = str(params.granularity);
    if (handle.length === 0) fail("agent_inspect requires handle");
    const requester = filerHandleOf(params, "requester");
    const isLead = typeof params.isLead === "boolean" ? params.isLead : requester === "lead";
    if (
      !canInspect({
        requester,
        isLead,
        targetHandle: handle,
        sharedItems: itemsOf(ctx, requester),
        targetItems: itemsOf(ctx, handle),
      })
    ) {
      fail(`${requester} may not inspect ${handle}`);
    }
    const spans = spansForHandle(ctx, handle);
    if (granularity === "timeline") {
      const where = str(params.where);
      const lines = inspectTimeline(spans, {
        ...(num(params.since) === undefined ? {} : { since: num(params.since) }),
        ...(num(params.limit) === undefined ? {} : { limit: num(params.limit) }),
        ...(where === "errors" || where === "writes" ? { where } : {}),
      });
      return {
        handle,
        granularity,
        lines,
        chargeUsd: INSPECT_CHARGE_USD,
        tokens: Math.ceil(lines.join("\n").length / 4),
      };
    }
    if (granularity === "step") {
      const step = num(params.step);
      if (step === undefined) fail("step requires a step number");
      const detail = inspectStep(spans, step as number);
      if (!detail) fail(`no step ${String(step)} for ${handle}`);
      return { handle, granularity, detail, chargeUsd: INSPECT_CHARGE_USD };
    }
    if (granularity === "reasoning") {
      const since = num(params.since) ?? 1;
      const limit = num(params.limit) ?? spans.length;
      return {
        handle,
        granularity,
        text: inspectReasoning(spans, since, since + limit - 1),
        chargeUsd: INSPECT_CHARGE_USD,
      };
    }
    fail(`unknown granularity: ${granularity}`);
  };

  handlers.activity_graph = async (rawParams) => {
    const { sessionId } = (rawParams ?? {}) as { sessionId?: string };
    const run = teamRunUsage(ctx, sessionId);
    const rows = new Map(agentsListPayload(ctx, sessionId).map((r) => [r.handle, r]));
    return {
      ...(sessionId === undefined ? {} : { sessionId }),
      ...buildActivityGraph({
        items: ctx.boardStore.list(),
        events: ctx.boardStore.listEvents(),
        agents: ctx.teamRegistry.list().map((a) => ({ handle: a.handle, role: a.role })),
        agentState: (handle) => rows.get(handle)?.state ?? "idle",
        agentCost: (handle) => run.perAgent[handle]?.costUsd ?? 0,
      }),
      perTask: run.perTask,
    };
  };

  handlers.agents_upsert = async (rawParams) => {
    const params = (rawParams ?? {}) as Record<string, unknown>;
    const handle = str(params.handle);
    if (!isValidAgentHandle(handle)) fail(`invalid handle: ${handle || "(empty)"}`);
    const role = str(params.role) || handle;
    const dir = join(ctx.options.workspaceRoot, ".agency", "agents");
    const file = join(dir, agentFileName(handle));
    let body = typeof params.body === "string" ? params.body : "";
    if (body.trim().length === 0) {
      try {
        body = existsSync(file) ? parseAgentFile(readFileSync(file, "utf8"), file).systemPrompt : "";
      } catch {
        body = "";
      }
    }
    if (body.trim().length === 0) body = `You are ${role}, an agency team agent.`;
    const lines = [`role: ${role}`];
    if (typeof params.provider === "string" && params.provider.length > 0)
      lines.push(`provider: ${params.provider}`);
    if (typeof params.model === "string" && params.model.length > 0) lines.push(`model: ${params.model}`);
    if (typeof params.effort === "string" && params.effort.length > 0) lines.push(`effort: ${params.effort}`);
    const tools = strList(params.tools);
    if (tools !== undefined) lines.push(`tools: ${JSON.stringify(tools)}`);
    if (params.permissions !== undefined) lines.push(`permissions: ${JSON.stringify(params.permissions)}`);
    const pathScope = strList(params.pathScope);
    if (pathScope !== undefined) lines.push(`pathScope: ${JSON.stringify(pathScope)}`);
    if (typeof params.replace === "boolean") lines.push(`replace: ${String(params.replace)}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, `---\n${lines.join("\n")}\n---\n${body.trim()}\n`, "utf8");
    const def = parseAgentFile(readFileSync(file, "utf8"), file);
    const cfg = ctx.config as unknown as {
      agents?: Record<string, Record<string, unknown>>;
    };
    cfg.agents ??= {};
    cfg.agents[handle] = {
      role: def.role,
      ...(def.provider === undefined ? {} : { provider: def.provider }),
      ...(def.model === undefined ? {} : { model: def.model }),
      ...(def.effort === undefined ? {} : { effort: def.effort }),
      ...(def.permissions === undefined ? {} : { permissions: def.permissions }),
      ...(def.systemPrompt.length > 0 ? { systemPrompt: def.systemPrompt } : {}),
      ...(def.replace === undefined ? {} : { replace: def.replace }),
      ...(def.tools === undefined ? {} : { tools: def.tools }),
      ...(def.pathScope === undefined ? {} : { pathScope: def.pathScope }),
    };
    let registered = false;
    if (def.provider !== undefined && def.effort !== undefined) {
      const prev = ctx.teamRegistry.get(handle);
      const resolvedModel = ctx.resolveAgentModel(def.provider, def.model);
      const modelInfo = ctx.catalogModel(def.provider, resolvedModel);
      ctx.teamRegistry.register({
        handle,
        role: def.role,
        provider: def.provider,
        model: resolvedModel,
        effort: clampEffortForModel(def.effort as import("@agency/providers").EffortLevel, modelInfo),
        sessionId: prev?.sessionId ?? `team-${handle}`,
        mailbox: prev?.mailbox ?? [],
        ...(def.systemPrompt.length > 0 ? { systemPrompt: def.systemPrompt } : {}),
        ...(def.replace === undefined ? {} : { replace: def.replace }),
        ...(def.tools === undefined ? {} : { tools: def.tools }),
        ...(def.pathScope === undefined ? {} : { pathScope: def.pathScope }),
      });
      registered = true;
    } else {
      ctx.logger.warn(
        `agent "${handle}" upserted without provider/effort: file written, registry unchanged until configured`,
      );
    }
    return { handle, file, registered };
  };
}
