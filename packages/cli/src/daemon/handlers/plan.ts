import { type ApprovalRequest, approvalArgsSummary, type RequestApproval } from "@agency/guard";
import type { MethodHandler } from "@agency/rpc";
import { AgencyError, ErrorCode } from "@agency/schema";
import { writeApprovalRecord } from "@agency/tools";
import type { DaemonContext, RunTurnParams } from "../types.ts";

export function createTurnApproval(
  ctx: DaemonContext,
  params: RunTurnParams,
  sessionId: string,
  eventStream: string,
): RequestApproval {
  const { approvalsFor, broadcast, eventBus, redactor } = ctx;
  const approvals = approvalsFor(sessionId);
  return async (request) => {
    const reply = (decision: string, closeReason: string): void => {
      try {
        eventBus.emit("permission.replied", {
          tool: request.tool,
          command: request.command,
          path: request.path,
          decision,
          closeReason,
        });
        eventBus.emit("event", {
          event: "permission.replied",
          payload: { tool: request.tool, decision, closeReason },
        });
      } catch {}
    };
    try {
      eventBus.emit("permission.asked", {
        tool: request.tool,
        command: request.command,
        path: request.path,
        decision: "ask",
      });
      eventBus.emit("event", { event: "permission.asked", payload: { tool: request.tool } });
    } catch {}
    if (approvals.hasAlways(request)) {
      reply("once", "answered");
      return "once";
    }
    const { id, promise } = approvals.createPending(request, params.turnId);
    const metaTier = request.metadata?.riskTier;
    const tier = request.riskTier ?? (typeof metaTier === "string" ? metaTier : undefined);
    const riskTier = tier ?? "unknown";
    const metaSource = request.metadata?.source;
    const source = request.source ?? (typeof metaSource === "string" ? metaSource : undefined) ?? "unknown";
    const title = redactor.redact(request.title);
    const command = request.command !== undefined ? redactor.redact(request.command) : undefined;
    const path = request.path !== undefined ? redactor.redact(request.path) : undefined;
    const argsSummary = approvalArgsSummary({
      ...(command !== undefined ? { command } : {}),
      ...(path !== undefined ? { path } : {}),
      title,
    });
    const redacted: ApprovalRequest = {
      ...request,
      title,
      ...(command !== undefined ? { command } : {}),
      ...(path !== undefined ? { path } : {}),
      ...(tier !== undefined ? { riskTier: tier as ApprovalRequest["riskTier"] } : {}),
      sessionId,
      turnId: params.turnId,
      source,
      argsSummary,
    };
    const payload = {
      type: "approval_requested" as const,
      requestId: id,
      sessionId,
      turnId: params.turnId,
      riskTier,
      source,
      argsSummary,
      request: redacted,
    };
    broadcast(eventStream, payload);
    if (params.sessionId !== undefined) broadcast(`session.${sessionId}`, payload);
    if (params.nonInteractive === true) {
      approvals.respond(id, "reject");
      reply("reject", "non-interactive");
      return "reject";
    }
    const decision = await promise;
    reply(decision, approvals.closeReason(id) ?? "answered");
    return decision;
  };
}

export function registerPlanHandlers(handlers: Record<string, MethodHandler>, ctx: DaemonContext): void {
  const { options, sandbox, sessionScopes } = ctx;
  handlers.plan_approve = async (rawParams) => {
    const { path, approvedBy } = rawParams as { path: string; approvedBy?: string };
    if (typeof path !== "string" || path.length === 0) {
      throw new AgencyError(ErrorCode.INTERNAL, "plan_approve requires a plan path", {
        source: "plan",
      });
    }
    const resolved = sandbox.resolvePath(path);
    try {
      const record = writeApprovalRecord(resolved, { approvedBy });
      return { record };
    } catch (error) {
      throw new AgencyError(ErrorCode.TOOL_ERROR, error instanceof Error ? error.message : String(error), {
        source: "plan",
        context: { path },
      });
    }
  };
  handlers.undo = async (rawParams?: unknown) => {
    const p = rawParams as { sessionId?: string } | undefined;
    const snapshots = options.tools
      ? undefined
      : ((p?.sessionId ? sessionScopes.get(p.sessionId)?.snapshots : undefined) ??
        sessionScopes.get("default")?.snapshots ??
        [...sessionScopes.values()][0]?.snapshots);
    const outcome = snapshots?.undo();
    return { undone: outcome !== undefined, ...(outcome ? { path: outcome.path } : {}) };
  };
  handlers.redo = async (rawParams?: unknown) => {
    const p = rawParams as { sessionId?: string } | undefined;
    const snapshots = options.tools
      ? undefined
      : ((p?.sessionId ? sessionScopes.get(p.sessionId)?.snapshots : undefined) ??
        sessionScopes.get("default")?.snapshots ??
        [...sessionScopes.values()][0]?.snapshots);
    const outcome = snapshots?.redo();
    return { undone: outcome !== undefined, ...(outcome ? { path: outcome.path } : {}) };
  };
}
