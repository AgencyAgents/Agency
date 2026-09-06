export type BoardStatus = "pending" | "in_progress" | "completed" | "ready_for_review";

export interface BoardItem {
  id: string;
  content: string;
  status: BoardStatus;
  claimedBy?: string;
}

export class BoardStore {
  private items: BoardItem[] = [];
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

  replace(items: BoardItem[]): void {
    this.items = [...items];
    void this.persist?.(this.items);
  }

  claim(handle: string, id: string): { ok: boolean; reason?: string } {
    const item = this.items.find((t) => t.id === id);
    if (!item) return { ok: false, reason: "not found" };
    if (item.claimedBy && item.claimedBy !== handle)
      return { ok: false, reason: `already claimed by ${item.claimedBy}` };
    item.claimedBy = handle;
    if (item.status === "pending") item.status = "in_progress";
    void this.persist?.(this.items);
    return { ok: true };
  }

  release(handle: string, id: string): { ok: boolean; reason?: string } {
    const item = this.items.find((t) => t.id === id);
    if (!item) return { ok: false, reason: "not found" };
    if (item.claimedBy !== handle) return { ok: false, reason: "not claimed by you" };
    delete item.claimedBy;
    void this.persist?.(this.items);
    return { ok: true };
  }

  setStatus(handle: string, id: string, status: BoardStatus): { ok: boolean; reason?: string } {
    const item = this.items.find((t) => t.id === id);
    if (!item) return { ok: false, reason: "not found" };
    if (status === "completed" && item.claimedBy === handle) {
      return { ok: false, reason: "cannot mark own claimed item completed; use ready_for_review" };
    }
    item.status = status;
    if (status === "completed" || status === "ready_for_review") delete item.claimedBy;
    void this.persist?.(this.items);
    return { ok: true };
  }

  hydrate(entries: BoardItem[]): void {
    this.items = [...entries];
  }
}
