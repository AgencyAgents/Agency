import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type BoardEvent, type BoardItem, boardToPlanFile, planFileToBoard } from "@agency/core";
import type { MethodHandler } from "@agency/rpc";
import { AgencyError, ErrorCode } from "@agency/schema";
import type { DaemonContext } from "../types.ts";

// Detached runs (Phase 12): the daemon owns the run, so a dead client
// loses nothing. Every board mutation fans out to the resumable ring as
// board_event plus wake, and to the legible .agency/board.md projection.
export const BOARD_FILE = "board.md";

export function boardFilePath(workspaceRoot: string): string {
  return join(workspaceRoot, ".agency", BOARD_FILE);
}

function fail(reason: string): never {
  throw new AgencyError(ErrorCode.INTERNAL, reason, { source: "detach" });
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function strList(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || !value.every((v) => typeof v === "string")) return undefined;
  return [...value];
}

function frameOf(event: BoardEvent): Record<string, unknown> {
  return {
    type: "board_event",
    seq: event.seq,
    at: event.at,
    itemId: event.itemId,
    by: event.by,
    move: event.move,
    ...(event.detail === undefined ? {} : { detail: event.detail }),
  };
}

// Wake without dispatch: inbox plus ring frame, never a turn. The
// no-progress fingerprint covers items only, so wakes never reset it.
function wakeAgent(ctx: DaemonContext, handle: string, item: BoardItem): void {
  try {
    ctx.boardStore.record(item.id, handle, `wake:${handle}`, item.id);
  } catch {}
  try {
    ctx.inboxStore.send({
      kind: "notify",
      from: "lead",
      to: handle,
      text: `wake: ${item.id} ready_for_review in your scope`,
    });
  } catch {}
  try {
    ctx.broadcast("team.shared", { type: "wake", handle, itemId: item.id, status: item.status });
  } catch {}
  try {
    ctx.eventBus.emit("team.wake", { handle, itemId: item.id });
  } catch {}
}

// Projects the board after every mutation. Sync write: the file is the
// detached user's read path, and a torn projection misleads steering.
export function projectBoardFile(ctx: DaemonContext): void {
  try {
    const file = boardFilePath(ctx.options.workspaceRoot);
    mkdirSync(join(file, ".."), { recursive: true });
    writeFileSync(file, boardToPlanFile(ctx.boardStore.list()), "utf8");
  } catch (error: unknown) {
    ctx.warnPersistence("board projection write", error);
  }
}

// Human-edit pickup: an unchecked completed item reopens to pending.
// Returns the reopened ids so callers can announce what steering landed.
export function syncBoardFile(ctx: DaemonContext): string[] {
  const file = boardFilePath(ctx.options.workspaceRoot);
  if (!existsSync(file)) return [];
  try {
    return planFileToBoard(ctx.boardStore, readFileSync(file, "utf8"), "human");
  } catch {
    return [];
  }
}

// One listener drives ring backlog, wake, and projection in board order:
// the status frame publishes before its wake so replays stay causal.
export function installDetachHook(ctx: DaemonContext): () => void {
  let seen = ctx.boardStore.listEvents().length;
  return ctx.boardStore.addListener(() => {
    try {
      const events = ctx.boardStore.listEvents();
      const fresh = events.slice(seen);
      seen = events.length;
      if (fresh.length === 0) return;
      const byId = new Map(ctx.boardStore.list().map((item) => [item.id, item]));
      for (const event of fresh) {
        try {
          ctx.broadcast("team.shared", frameOf(event));
        } catch {}
        if (event.move !== "status:ready_for_review") continue;
        const item = byId.get(event.itemId);
        if (item?.status !== "ready_for_review") continue;
        for (const interest of ctx.wakeInterests.matchForItem(item)) {
          wakeAgent(ctx, interest.handle, item);
        }
      }
      projectBoardFile(ctx);
    } catch {}
  });
}

// Polls the projection mtime: without a client attached nobody calls
// sync, so the daemon notices file steering on its own. Stat-only when
// idle, one parse per real edit.
export function startBoardFileSync(ctx: DaemonContext, intervalMs = 1_000): () => void {
  let lastMtime = 0;
  try {
    lastMtime = statSync(boardFilePath(ctx.options.workspaceRoot)).mtimeMs;
  } catch {}
  const timer = setInterval(() => {
    try {
      const mtime = statSync(boardFilePath(ctx.options.workspaceRoot)).mtimeMs;
      if (mtime === lastMtime) return;
      lastMtime = mtime;
      const reopened = syncBoardFile(ctx);
      if (reopened.length > 0) projectBoardFile(ctx);
    } catch {}
  }, intervalMs);
  if (typeof timer.unref === "function") timer.unref();
  return () => clearInterval(timer);
}

export function registerDetachHandlers(handlers: Record<string, MethodHandler>, ctx: DaemonContext): void {
  handlers.board_status = async (rawParams) => {
    const params = (rawParams ?? {}) as Record<string, unknown>;
    const handle = str(params.handle).length > 0 ? str(params.handle) : "lead";
    const id = str(params.id);
    const status = str(params.status);
    if (id.length === 0) fail("board_status requires id");
    if (!["pending", "in_progress", "completed", "ready_for_review", "needs-user"].includes(status)) {
      fail(`unknown status: ${status}`);
    }
    const outcome = ctx.boardStore.setStatus(handle, id, status as BoardItem["status"], params.result);
    if (!outcome.ok) fail(outcome.reason ?? "status failed");
    return { id, status, handle };
  };

  handlers.wake_subscribe = async (rawParams) => {
    const params = (rawParams ?? {}) as Record<string, unknown>;
    const outcome = ctx.wakeInterests.subscribe({
      handle: str(params.handle),
      pathScopes: strList(params.pathScope) ?? [],
      ...(typeof params.onEvent === "string" ? { onEvent: params.onEvent } : {}),
    });
    if (!outcome.ok) fail(outcome.reason);
    return { interest: (outcome as { ok: true; interest: unknown }).interest };
  };

  handlers.wake_unsubscribe = async (rawParams) => {
    const handle = str((rawParams as Record<string, unknown>)?.handle);
    if (handle.length === 0) fail("wake_unsubscribe requires handle");
    return { handle, removed: ctx.wakeInterests.unsubscribe(handle) };
  };
}
