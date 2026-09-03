import type { SessionEntry, SessionStore } from "@agency/core";
import { getSessionTitle } from "@agency/core";

export type BrowserFilter = "all" | "bookmarks" | "recent";

export interface BrowserEntry {
  id: string;
  createdAt: string;
  messageCount: number;
  isBookmarked: boolean;
  title?: string;
}

export interface BrowserNode {
  entry: BrowserEntry;
  children: BrowserNode[];
  depth: number;
}

/**
 * Session tree browser: search, filter modes, bookmarks, and branch
 * operations (fork/clone/resume etc. are delegated to SessionStore).
 */
export class SessionBrowser {
  private bookmarks = new Set<string>();

  constructor(private readonly store: SessionStore) {}

  list(filter: BrowserFilter = "all"): BrowserEntry[] {
    const ids = this.store.list();
    const entries: BrowserEntry[] = [];
    for (const id of ids) {
      const loaded = this.store.load(id);
      const isBookmarked = this.bookmarks.has(id);
      if (filter === "bookmarks" && !isBookmarked) continue;
      entries.push({
        id,
        createdAt: loaded[0]?.createdAt ?? new Date().toISOString(),
        messageCount: loaded.length,
        isBookmarked,
        title: getSessionTitle(loaded),
      });
    }
    if (filter === "recent") {
      entries.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      return entries.slice(0, 10);
    }
    entries.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    return entries;
  }

  search(query: string, filter: BrowserFilter = "all"): BrowserEntry[] {
    const needle = query.trim().toLowerCase();
    if (needle === "") return this.list(filter);
    return this.list(filter).filter((e) => e.id.toLowerCase().includes(needle) || (e.title?.toLowerCase().includes(needle) ?? false));
  }

  bookmark(id: string): void {
    this.bookmarks.add(id);
  }

  unbookmark(id: string): void {
    this.bookmarks.delete(id);
  }

  isBookmarked(id: string): boolean {
    return this.bookmarks.has(id);
  }

  /** Tree for a given session id, built from parentId links. */
  tree(sessionId: string): BrowserNode[] {
    const entries = this.store.load(sessionId);
    const byParent = new Map<string | null, SessionEntry[]>();
    for (const e of entries) {
      const list = byParent.get(e.parentId) ?? [];
      list.push(e);
      byParent.set(e.parentId, list);
    }
    const build = (parentId: string | null, depth: number): BrowserNode[] => {
      const children = byParent.get(parentId) ?? [];
      return children.map((entry) => ({
        entry: {
          id: entry.id,
          createdAt: entry.createdAt,
          messageCount: 1,
          isBookmarked: this.bookmarks.has(entry.id),
        },
        children: build(entry.id, depth + 1),
        depth,
      }));
    };
    return build(null, 0);
  }

  /** Flat frame for rendering: indented lines with bookmark marker. */
  frame(filter: BrowserFilter = "all", query = ""): string[] {
    const entries = query ? this.search(query, filter) : this.list(filter);
    if (entries.length === 0) return ["(no sessions)"];
    return entries.map((e) => {
      const mark = e.isBookmarked ? "*" : " ";
      const title = e.title ? ` — ${e.title}` : "";
      return `${mark} ${e.id} (${e.messageCount})${title}`;
    });
  }
}
