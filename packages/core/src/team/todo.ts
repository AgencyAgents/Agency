import { intersectPathScopes } from "@agency/guard";

export type BoardStatus = "pending" | "in_progress" | "completed" | "ready_for_review" | "needs-user";

export interface BoardItem {
  id: string;
  content: string;
  status: BoardStatus;
  claimedBy?: string;
  acceptanceCriteria?: string;
  briefing?: string;
  pathScope?: string[];
  budgetUsd?: number;
  budgetTurns?: number;
  tools?: string[];
  filedBy?: string;
  counterOf?: string;
  declineReason?: string;
  escalateQuestion?: string;
  failureNote?: string;
}

export type ContractMove = "accept" | "decline" | "counter" | "escalate";

export interface BoardEvent {
  seq: number;
  at: string;
  itemId: string;
  by: string;
  move: string;
  detail?: string;
}

export interface BoardResult {
  filesTouched: string[];
  verificationRun: string;
  decisions: string[];
  openQuestions: string[];
}

export function validateBoardResult(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null) return "result must be an object";
  const result = value as Record<string, unknown>;
  if (!Array.isArray(result.filesTouched) || !result.filesTouched.every((f) => typeof f === "string")) {
    return "result.filesTouched must be a string array";
  }
  if (typeof result.verificationRun !== "string" || result.verificationRun.length === 0) {
    return "result.verificationRun must be a non-empty string";
  }
  if (!Array.isArray(result.decisions) || !result.decisions.every((d) => typeof d === "string")) {
    return "result.decisions must be a string array";
  }
  if (!Array.isArray(result.openQuestions) || !result.openQuestions.every((q) => typeof q === "string")) {
    return "result.openQuestions must be a string array";
  }
  return undefined;
}

export interface FileItemRequest {
  id?: string;
  content: string;
  acceptanceCriteria?: string;
  briefing?: string;
  pathScope?: string[];
  budgetUsd?: number;
  budgetTurns?: number;
  tools?: string[];
}

export interface FilerGrants {
  pathScope?: readonly string[] | "*";
  tools?: readonly string[] | "*";
  budgetUsd?: number;
  budgetTurns?: number;
}

const WRITE_TOOLS: ReadonlySet<string> = new Set(["write", "edit", "bash", "spawn", "dispatch"]);

export class BoardStore {
  private items: BoardItem[] = [];
  private readonly events: BoardEvent[] = [];
  private seq = 0;
  private persist?: (todos: BoardItem[]) => Promise<void>;

  constructor(opts?: {
    persist?: (todos: BoardItem[]) => Promise<void>;
    initial?: BoardItem[];
  }) {
    if (opts?.initial) this.items = [...opts.initial];
    if (opts?.persist) this.persist = opts.persist;
  }

  list(): BoardItem[] {
    return [...this.items];
  }

  listEvents(): BoardEvent[] {
    return [...this.events];
  }

  record(itemId: string, by: string, move: string, detail?: string): void {
    this.seq += 1;
    this.events.push({
      seq: this.seq,
      at: new Date().toISOString(),
      itemId,
      by,
      move,
      ...(detail === undefined ? {} : { detail }),
    });
  }

  replace(items: BoardItem[]): void {
    this.items = [...items];
    void this.persist?.(this.items);
  }

  file(
    req: FileItemRequest,
    filedBy: string,
    grants?: FilerGrants,
  ): { ok: true; item: BoardItem } | { ok: false; reason: string } {
    if (req.content.trim().length === 0) return { ok: false, reason: "content must be non-empty" };
    const scopes = intersectPathScopes(req.pathScope, grants?.pathScope);
    if (req.pathScope !== undefined && req.pathScope.length > 0 && scopes.scopes.length === 0) {
      return { ok: false, reason: `item refused: path scope outside ${filedBy}'s own grant` };
    }
    const tools = this.intersectTools(req.tools, grants?.tools);
    if (tools.refused) {
      return { ok: false, reason: `item refused: ${filedBy} lacks the requested write tools` };
    }
    const existing = new Set(this.items.map((item) => item.id));
    const id = req.id !== undefined && req.id.length > 0 ? req.id : `item-${this.items.length + 1}`;
    if (existing.has(id)) return { ok: false, reason: `duplicate item id: ${id}` };
    const budgetUsd = this.cap(req.budgetUsd, grants?.budgetUsd);
    const budgetTurns = this.cap(req.budgetTurns, grants?.budgetTurns);
    const item: BoardItem = {
      id,
      content: req.content,
      status: "pending",
      ...(req.acceptanceCriteria === undefined ? {} : { acceptanceCriteria: req.acceptanceCriteria }),
      ...(req.briefing === undefined ? {} : { briefing: req.briefing }),
      ...(scopes.scopes.length === 0 ? {} : { pathScope: scopes.scopes }),
      ...(budgetUsd === undefined ? {} : { budgetUsd }),
      ...(budgetTurns === undefined ? {} : { budgetTurns }),
      ...(tools.kept === undefined ? {} : { tools: tools.kept }),
      filedBy,
    };
    this.items = [...this.items, item];
    this.record(id, filedBy, "file");
    void this.persist?.(this.items);
    return { ok: true, item };
  }

  private cap(requested: number | undefined, grant: number | undefined): number | undefined {
    if (requested === undefined) return grant;
    if (grant === undefined) return requested;
    return Math.min(requested, grant);
  }

  private intersectTools(
    requested: string[] | undefined,
    grants: readonly string[] | "*" | undefined,
  ): { kept: string[] | undefined; refused: boolean } {
    if (grants === undefined || grants === "*") {
      return { kept: requested === undefined ? undefined : [...requested], refused: false };
    }
    if (requested === undefined) return { kept: [...grants], refused: false };
    const kept = requested.filter((tool) => grants.includes(tool));
    const droppedWrite = requested.some((tool) => WRITE_TOOLS.has(tool) && !grants.includes(tool));
    if (kept.length === 0 && requested.length > 0) return { kept: [], refused: true };
    return { kept, refused: droppedWrite };
  }

  claim(handle: string, id: string): { ok: boolean; reason?: string } {
    const item = this.items.find((t) => t.id === id);
    if (!item) return { ok: false, reason: "not found" };
    if (item.claimedBy && item.claimedBy !== handle)
      return { ok: false, reason: `already claimed by ${item.claimedBy}` };
    item.claimedBy = handle;
    delete item.declineReason;
    if (item.status === "pending") item.status = "in_progress";
    this.record(id, handle, "accept");
    void this.persist?.(this.items);
    return { ok: true };
  }

  decline(handle: string, id: string, reason: string): { ok: boolean; reason?: string } {
    const item = this.items.find((t) => t.id === id);
    if (!item) return { ok: false, reason: "not found" };
    if (reason.trim().length === 0) return { ok: false, reason: "decline requires a reason" };
    delete item.claimedBy;
    item.status = "pending";
    item.declineReason = reason;
    this.record(id, handle, "decline", reason);
    void this.persist?.(this.items);
    return { ok: true };
  }

  counter(
    handle: string,
    id: string,
    narrower: FileItemRequest,
    grants?: FilerGrants,
  ): { ok: true; item: BoardItem } | { ok: false; reason: string } {
    const parent = this.items.find((t) => t.id === id);
    if (!parent) return { ok: false, reason: "not found" };
    const parentScopes = parent.pathScope ?? [];
    for (const scope of narrower.pathScope ?? []) {
      const inside = parentScopes.length === 0 || parentScopes.some((own) => this.scopeCovers(own, scope));
      if (!inside) return { ok: false, reason: `counter must narrow scope: ${scope} exceeds the item` };
    }
    const filed = this.file(narrower, handle, grants);
    if (!filed.ok) return filed;
    filed.item.counterOf = id;
    delete parent.claimedBy;
    parent.status = "pending";
    parent.failureNote = `countered by ${handle} as ${filed.item.id}`;
    this.record(id, handle, "counter", filed.item.id);
    void this.persist?.(this.items);
    return { ok: true, item: filed.item };
  }

  private scopeCovers(own: string, requested: string): boolean {
    const a = own.replace(/\\/g, "/");
    const b = requested.replace(/\\/g, "/");
    if (a === "**" || a === "/**") return true;
    if (a.endsWith("/**")) {
      const prefix = a.slice(0, -3);
      return b === a || b === prefix || b.startsWith(`${prefix}/`);
    }
    return a === b;
  }

  escalate(handle: string, id: string, question: string): { ok: boolean; reason?: string } {
    const item = this.items.find((t) => t.id === id);
    if (!item) return { ok: false, reason: "not found" };
    if (question.trim().length === 0) return { ok: false, reason: "escalate requires a question" };
    delete item.claimedBy;
    item.status = "needs-user";
    item.escalateQuestion = question;
    this.record(id, handle, "escalate", question);
    void this.persist?.(this.items);
    return { ok: true };
  }

  release(handle: string, id: string): { ok: boolean; reason?: string } {
    const item = this.items.find((t) => t.id === id);
    if (!item) return { ok: false, reason: "not found" };
    if (item.claimedBy !== handle) return { ok: false, reason: "not claimed by you" };
    delete item.claimedBy;
    this.record(id, handle, "release");
    void this.persist?.(this.items);
    return { ok: true };
  }

  setStatus(
    handle: string,
    id: string,
    status: BoardStatus,
    result?: unknown,
  ): { ok: boolean; reason?: string } {
    const item = this.items.find((t) => t.id === id);
    if (!item) return { ok: false, reason: "not found" };
    if (status === "completed" && item.claimedBy === handle) {
      return { ok: false, reason: "cannot mark own claimed item completed; use ready_for_review" };
    }
    if ((status === "ready_for_review" || status === "completed") && result !== undefined) {
      const problem = validateBoardResult(result);
      if (problem !== undefined) return { ok: false, reason: problem };
    }
    item.status = status;
    if (status === "completed" || status === "ready_for_review") delete item.claimedBy;
    this.record(id, handle, `status:${status}`);
    void this.persist?.(this.items);
    return { ok: true };
  }

  failToPending(handle: string, id: string, note: string): { ok: boolean; reason?: string } {
    const item = this.items.find((t) => t.id === id);
    if (!item) return { ok: false, reason: "not found" };
    delete item.claimedBy;
    item.status = "pending";
    item.failureNote = note;
    this.record(id, handle, "fail", note);
    void this.persist?.(this.items);
    return { ok: true };
  }

  hydrate(entries: BoardItem[]): void {
    this.items = [...entries];
  }
}
