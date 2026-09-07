import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type BoardBackend,
  type BoardItemLike,
  boardPermissionsFromMap,
  createBoardTools,
} from "../../src/builtins/board.ts";
import type { ToolContext } from "../../src/contract.ts";

function fakeBackend(): BoardBackend & { items: BoardItemLike[] } {
  const items: BoardItemLike[] = [];
  return {
    items,
    list: () => [...items],
    file: (req, filedBy) => {
      const item: BoardItemLike = {
        id: `item-${items.length + 1}`,
        content: req.content,
        status: "pending",
        filedBy,
      };
      items.push(item);
      return { ok: true, item };
    },
    claim: (handle, id) => {
      const item = items.find((i) => i.id === id);
      if (!item) return { ok: false, reason: "not found" };
      item.claimedBy = handle;
      item.status = "in_progress";
      return { ok: true };
    },
    decline: (_handle, id, _reason) => {
      const item = items.find((i) => i.id === id);
      if (!item) return { ok: false, reason: "not found" };
      delete item.claimedBy;
      item.status = "pending";
      return { ok: true };
    },
    counter: (handle, _id, narrower) => {
      const item: BoardItemLike = {
        id: `item-${items.length + 1}`,
        content: narrower.content,
        status: "pending",
        filedBy: handle,
      };
      items.push(item);
      return { ok: true, item };
    },
    escalate: (_handle, id) => {
      const item = items.find((i) => i.id === id);
      if (!item) return { ok: false, reason: "not found" };
      item.status = "needs-user";
      return { ok: true };
    },
    setStatus: (_handle, id, status, result) => {
      const item = items.find((i) => i.id === id);
      if (!item) return { ok: false, reason: "not found" };
      if (result !== undefined) {
        const r = result as Record<string, unknown>;
        if (!Array.isArray(r.filesTouched) || typeof r.verificationRun !== "string") {
          return { ok: false, reason: "result.filesTouched must be a string array" };
        }
      }
      item.status = status;
      return { ok: true };
    },
  };
}

function ctxFor(handle: string): ToolContext {
  return { signal: new AbortController().signal, agentHandle: handle };
}

function depsFor(backend: BoardBackend, handle: string, permissions?: Record<string, unknown>) {
  return {
    backend,
    resolveFiler: () => ({
      handle,
      grants: { pathScope: ["src/**"] as string[], tools: ["read", "write", "edit"] as string[] },
    }),
    allowed: boardPermissionsFromMap(permissions),
    workspaceRoot: mkdtempSync(join(tmpdir(), "agency-board-")),
  };
}

describe("board tools gated per agent", () => {
  it("tools deny when the permission map omits them", async () => {
    const backend = fakeBackend();
    const tools = createBoardTools(depsFor(backend, "coder", { board_read: "allow" }));
    const byName = new Map(tools.map((t) => [t.name, t]));
    expect([...byName.keys()]).toEqual([
      "board_read",
      "board_claim",
      "board_status",
      "task_file",
      "owners_read",
    ]);
    const claim = byName.get("board_claim");
    if (!claim) throw new Error("board_claim missing");
    const outcome = await claim.handler({ id: "x", move: "accept" }, ctxFor("coder"));
    expect(outcome.isError).toBe(true);
    expect(outcome.content).toContain("not permitted");
  });

  it("task_file plus board_claim accept complete a lateral handoff", async () => {
    const backend = fakeBackend();
    const coder = createBoardTools(
      depsFor(backend, "coder", {
        board_read: "allow",
        board_claim: "allow",
        board_status: "allow",
        task_file: "allow",
        owners_read: "allow",
      }),
    );
    const researcher = createBoardTools({
      ...depsFor(backend, "researcher"),
      allowed: boardPermissionsFromMap({
        board_read: "allow",
        board_claim: "allow",
        board_status: "allow",
        task_file: "allow",
        owners_read: "allow",
      }),
    });
    const byName = (tools: ReturnType<typeof createBoardTools>) => new Map(tools.map((t) => [t.name, t]));
    const coderTools = byName(coder);
    const researcherTools = byName(researcher);
    const fileTool = coderTools.get("task_file");
    if (!fileTool) throw new Error("task_file missing");
    const filed = await fileTool.handler(
      { content: "research oauth", pathScope: ["src/auth/**"] },
      ctxFor("coder"),
    );
    expect(filed.isError).toBeUndefined();
    expect(filed.content).toContain("filed");
    const claimTool = researcherTools.get("board_claim");
    if (!claimTool) throw new Error("board_claim missing");
    const itemId = backend.list()[0]?.id ?? "";
    const claimed = await claimTool.handler({ id: itemId, move: "accept" }, ctxFor("researcher"));
    expect(claimed.isError).toBeUndefined();
    const statusTool = researcherTools.get("board_status");
    if (!statusTool) throw new Error("board_status missing");
    const bad = await statusTool.handler({ id: itemId, status: "ready_for_review" }, ctxFor("researcher"));
    expect(bad.isError).toBeUndefined();
    const invalid = await statusTool.handler(
      { id: itemId, status: "completed", result: { nope: 1 } },
      ctxFor("researcher"),
    );
    expect(invalid.isError).toBe(true);
    const readTool = researcherTools.get("board_read");
    if (!readTool) throw new Error("board_read missing");
    const read = await readTool.handler({}, ctxFor("researcher"));
    expect(read.content).toContain(itemId);
  });

  it("owners_read resolves roles from .agency/owners", async () => {
    const backend = fakeBackend();
    const root = mkdtempSync(join(tmpdir(), "agency-owners-"));
    mkdirSync(join(root, ".agency"), { recursive: true });
    mkdirSync(join(root, ".agency"), { recursive: true });
    writeFileSync(join(root, ".agency", "owners"), "src/auth/** @security @coder\n", "utf8");
    const tools = createBoardTools({
      backend,
      resolveFiler: () => ({ handle: "coder", grants: {} }),
      allowed: () => true,
      workspaceRoot: root,
    });
    const owners = tools.find((t) => t.name === "owners_read");
    if (!owners) throw new Error("owners_read missing");
    const outcome = await owners.handler({ path: "src/auth/login.ts" }, ctxFor("coder"));
    expect(outcome.content).toContain("security");
    expect(outcome.content).toContain("coder");
    const none = await owners.handler({ path: "src/other/x.ts" }, ctxFor("coder"));
    expect(none.content).toBe("(no owner)");
  });
});
