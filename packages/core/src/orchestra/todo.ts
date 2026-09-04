export type OrchestraTodoStatus = "pending" | "in_progress" | "completed" | "ready_for_review";

export interface OrchestraTodoItem {
  id: string;
  content: string;
  status: OrchestraTodoStatus;
  claimedBy?: string;
}

export class OrchestraTodoStore {
  private items: OrchestraTodoItem[] = [];
  private persist?: (todos: OrchestraTodoItem[]) => Promise<void>;

  constructor(opts?: {
    persist?: (todos: OrchestraTodoItem[]) => Promise<void>;
    initial?: OrchestraTodoItem[];
  }) {
    if (opts?.initial) this.items = [...opts.initial];
    if (opts?.persist) this.persist = opts.persist;
  }

  list(): OrchestraTodoItem[] {
    return [...this.items];
  }

  replace(items: OrchestraTodoItem[]): void {
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

  setStatus(handle: string, id: string, status: OrchestraTodoStatus): { ok: boolean; reason?: string } {
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

  hydrate(entries: OrchestraTodoItem[]): void {
    this.items = [...entries];
  }
}
