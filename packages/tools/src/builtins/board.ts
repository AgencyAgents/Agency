import type { ToolContext, ToolSpec } from "../contract.ts";

export interface BoardItemLike {
  id: string;
  content: string;
  status: string;
  claimedBy?: string;
  acceptanceCriteria?: string;
  briefing?: string;
  pathScope?: string[];
  budgetUsd?: number;
  budgetTurns?: number;
  filedBy?: string;
}

export interface FilerGrantsLike {
  pathScope?: readonly string[] | "*";
  tools?: readonly string[] | "*";
  budgetUsd?: number;
  budgetTurns?: number;
}

export interface FileItemLike {
  id?: string;
  content: string;
  acceptanceCriteria?: string;
  briefing?: string;
  pathScope?: string[];
  budgetUsd?: number;
  budgetTurns?: number;
  tools?: string[];
}

export interface BoardBackend {
  list(): BoardItemLike[];
  file(
    req: FileItemLike,
    filedBy: string,
    grants?: FilerGrantsLike,
  ): { ok: true; item: BoardItemLike } | { ok: false; reason: string };
  claim(handle: string, id: string): { ok: boolean; reason?: string };
  decline(handle: string, id: string, reason: string): { ok: boolean; reason?: string };
  counter(
    handle: string,
    id: string,
    narrower: FileItemLike,
    grants?: FilerGrantsLike,
  ): { ok: true; item: BoardItemLike } | { ok: false; reason: string };
  escalate(handle: string, id: string, question: string): { ok: boolean; reason?: string };
  setStatus(handle: string, id: string, status: string, result?: unknown): { ok: boolean; reason?: string };
}

export interface BoardFiler {
  handle: string;
  grants: FilerGrantsLike;
}

export interface BoardToolDeps {
  backend: BoardBackend;
  resolveFiler: (ctx: ToolContext) => BoardFiler;
  allowed: (tool: string) => boolean;
  workspaceRoot: string;
  ownersFile?: string;
}

function denied(tool: string): { content: string; isError: boolean } {
  return { content: `${tool} is not permitted for this agent`, isError: true };
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function num(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

function strArray(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || !value.every((v) => typeof v === "string")) return undefined;
  return [...value];
}

export function boardPermissionsFromMap(
  permissions: Record<string, unknown> | undefined,
): (tool: string) => boolean {
  return (tool: string) => {
    if (permissions === undefined) return true;
    const entry = permissions[tool];
    if (entry === "deny") return false;
    if (entry === undefined) return false;
    return true;
  };
}

function renderItems(items: BoardItemLike[]): string {
  if (items.length === 0) return "board is empty";
  return items
    .map(
      (item) => `[${item.status}] ${item.content} (${item.id}${item.claimedBy ? ` @${item.claimedBy}` : ""})`,
    )
    .join("\n");
}

export function createBoardReadTool(deps: BoardToolDeps): ToolSpec {
  const spec: ToolSpec<Record<string, never>> = {
    name: "board_read",
    description: "Reads the team board: every item with status, claim, and path scope.",
    inputSchema: { type: "object", properties: {} },
    riskTier: "safe",
    renderCall: () => "board_read",
    renderResult: (result) => (result.isError ? `board_read failed: ${result.content}` : result.content),
    async handler(_input, _ctx) {
      if (!deps.allowed("board_read")) return denied("board_read");
      return { content: renderItems(deps.backend.list()) };
    },
  };
  return spec;
}

export function createBoardClaimTool(deps: BoardToolDeps): ToolSpec {
  const spec: ToolSpec = {
    name: "board_claim",
    description: "Accept, decline with reason, counter with narrower scope, or escalate a board item.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        move: { type: "string", enum: ["accept", "decline", "counter", "escalate"] },
        reason: { type: "string" },
        question: { type: "string" },
        content: { type: "string" },
        pathScope: { type: "array", items: { type: "string" } },
        budgetUsd: { type: "number" },
        budgetTurns: { type: "number" },
      },
      required: ["id", "move"],
    },
    riskTier: "moderate",
    renderCall: (input) => `board_claim ${str(input.id)} ${str(input.move)}`,
    renderResult: (result) => (result.isError ? `board_claim failed: ${result.content}` : result.content),
    async handler(input, ctx) {
      if (!deps.allowed("board_claim")) return denied("board_claim");
      const filer = deps.resolveFiler(ctx);
      const id = str(input.id);
      const move = str(input.move);
      if (id.length === 0) return { content: "board_claim requires id", isError: true };
      if (move === "accept") {
        const outcome = deps.backend.claim(filer.handle, id);
        return outcome.ok
          ? { content: `${filer.handle} accepted ${id}` }
          : { content: outcome.reason ?? "claim failed", isError: true };
      }
      if (move === "decline") {
        const reason = str(input.reason);
        if (reason.length === 0) return { content: "decline requires a reason", isError: true };
        const outcome = deps.backend.decline(filer.handle, id, reason);
        return outcome.ok
          ? { content: `${filer.handle} declined ${id}: ${reason}` }
          : { content: outcome.reason ?? "decline failed", isError: true };
      }
      if (move === "counter") {
        const content = str(input.content);
        if (content.trim().length === 0) {
          return { content: "counter requires content", isError: true };
        }
        const narrower: FileItemLike = { content };
        const scope = strArray(input.pathScope);
        if (scope) narrower.pathScope = scope;
        const budgetUsd = num(input.budgetUsd);
        if (budgetUsd !== undefined) narrower.budgetUsd = budgetUsd;
        const budgetTurns = num(input.budgetTurns);
        if (budgetTurns !== undefined) narrower.budgetTurns = budgetTurns;
        const outcome = deps.backend.counter(filer.handle, id, narrower, filer.grants);
        return outcome.ok
          ? { content: `${filer.handle} countered ${id} as ${outcome.item.id}` }
          : { content: outcome.reason, isError: true };
      }
      if (move === "escalate") {
        const question = str(input.question);
        if (question.length === 0) return { content: "escalate requires a question", isError: true };
        const outcome = deps.backend.escalate(filer.handle, id, question);
        return outcome.ok
          ? { content: `${filer.handle} escalated ${id}: ${question}` }
          : { content: outcome.reason ?? "escalate failed", isError: true };
      }
      return { content: `unknown move: ${move}`, isError: true };
    },
  };
  return spec;
}

export function createBoardStatusTool(deps: BoardToolDeps): ToolSpec {
  const spec: ToolSpec = {
    name: "board_status",
    description: "Moves a board item across statuses with the structured return contract on review.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        status: {
          type: "string",
          enum: ["pending", "in_progress", "completed", "ready_for_review", "needs-user"],
        },
        result: { type: "object" },
      },
      required: ["id", "status"],
    },
    riskTier: "moderate",
    renderCall: (input) => `board_status ${str(input.id)} ${str(input.status)}`,
    renderResult: (result) => (result.isError ? `board_status failed: ${result.content}` : result.content),
    async handler(input, ctx) {
      if (!deps.allowed("board_status")) return denied("board_status");
      const filer = deps.resolveFiler(ctx);
      const id = str(input.id);
      const status = str(input.status);
      if (id.length === 0 || status.length === 0) {
        return { content: "board_status requires id and status", isError: true };
      }
      const outcome = deps.backend.setStatus(filer.handle, id, status, input.result);
      return outcome.ok
        ? { content: `${id} now ${status}` }
        : { content: outcome.reason ?? "status failed", isError: true };
    },
  };
  return spec;
}

export function createTaskFileTool(deps: BoardToolDeps): ToolSpec {
  const spec: ToolSpec = {
    name: "task_file",
    description: "Files a board item with goal, acceptance criteria, path scope, and budget.",
    inputSchema: {
      type: "object",
      properties: {
        content: { type: "string" },
        acceptanceCriteria: { type: "string" },
        briefing: { type: "string" },
        pathScope: { type: "array", items: { type: "string" } },
        budgetUsd: { type: "number" },
        budgetTurns: { type: "number" },
        tools: { type: "array", items: { type: "string" } },
      },
      required: ["content"],
    },
    riskTier: "moderate",
    renderCall: (input) => `task_file ${str(input.content).slice(0, 80)}`,
    renderResult: (result) => (result.isError ? `task_file failed: ${result.content}` : result.content),
    async handler(input, ctx) {
      if (!deps.allowed("task_file")) return denied("task_file");
      const filer = deps.resolveFiler(ctx);
      const content = str(input.content);
      if (content.trim().length === 0) return { content: "task_file requires content", isError: true };
      const req: FileItemLike = { content };
      if (typeof input.acceptanceCriteria === "string") req.acceptanceCriteria = input.acceptanceCriteria;
      if (typeof input.briefing === "string") req.briefing = input.briefing;
      const scope = strArray(input.pathScope);
      if (scope) req.pathScope = scope;
      const budgetUsd = num(input.budgetUsd);
      if (budgetUsd !== undefined) req.budgetUsd = budgetUsd;
      const budgetTurns = num(input.budgetTurns);
      if (budgetTurns !== undefined) req.budgetTurns = budgetTurns;
      const tools = strArray(input.tools);
      if (tools) req.tools = tools;
      const outcome = deps.backend.file(req, filer.handle, filer.grants);
      return outcome.ok
        ? { content: `filed ${outcome.item.id}` }
        : { content: outcome.reason, isError: true };
    },
  };
  return spec;
}

export function createOwnersReadTool(deps: BoardToolDeps): ToolSpec {
  const spec: ToolSpec = {
    name: "owners_read",
    description: "Resolves which roles own a path from the .agency/owners map.",
    inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
    riskTier: "safe",
    renderCall: (input) => `owners_read ${str(input.path)}`,
    renderResult: (result) => (result.isError ? `owners_read failed: ${result.content}` : result.content),
    async handler(input, _ctx) {
      if (!deps.allowed("owners_read")) return denied("owners_read");
      const path = str(input.path);
      if (path.length === 0) return { content: "owners_read requires path", isError: true };
      const { loadOwnersFile, ownersForPath } = await import("./owners-query.ts");
      const rules = loadOwnersFile(deps.workspaceRoot, deps.ownersFile);
      const handles = ownersForPath(rules, path);
      return { content: handles.length > 0 ? handles.join(" ") : "(no owner)" };
    },
  };
  return spec;
}

export function createBoardTools(deps: BoardToolDeps): ToolSpec[] {
  return [
    createBoardReadTool(deps),
    createBoardClaimTool(deps),
    createBoardStatusTool(deps),
    createTaskFileTool(deps),
    createOwnersReadTool(deps),
  ];
}
