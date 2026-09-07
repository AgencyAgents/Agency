import { scopeMatchesPattern } from "@agency/guard";
import type { BoardItem } from "./todo.ts";

// Standing wake interests (7.8): an agent never dispatched still acts
// when a scoped item reaches review. Matching reuses scopeMatchesPattern,
// the same matcher behind owners and review gates, so one fix lands twice.
export type WakeEvent = "ready_for_review";

export interface WakeInterest {
  handle: string;
  pathScopes: string[];
  onEvent: WakeEvent;
}

// Overlap in either direction: the item may be narrower (a file under
// the interest) or broader (a tree containing it). Both wake.
// Both narrow and broad matches are intentional: an agent interested in
// src/auth/** should wake on both src/auth/login.ts and src/**.
export function wakeScopeOverlaps(interest: WakeInterest, item: BoardItem): boolean {
  const scopes = item.pathScope ?? [];
  if (scopes.length === 0 || interest.pathScopes.length === 0) return false;
  return interest.pathScopes.some((pattern) =>
    scopes.some((scope) => scopeMatchesPattern(pattern, scope) || scopeMatchesPattern(scope, pattern)),
  );
}

export function wakeMatches(interest: WakeInterest, item: BoardItem): boolean {
  if (interest.onEvent !== "ready_for_review") return false;
  if (item.status !== "ready_for_review") return false;
  return wakeScopeOverlaps(interest, item);
}

// Pure registry: no timers, no polling. An interest that never matches
// costs nothing; a match wakes exactly its subscribed handles.

/** Trim a raw handle; return null if missing, non-string, or empty. */
function normalizeHandle(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const t = raw.trim();
  return t.length === 0 ? null : t;
}

export class WakeRegistry {
  private readonly interests = new Map<string, WakeInterest>();

  subscribe(req: {
    handle: string;
    pathScopes: string[];
    onEvent?: string;
  }): { ok: true; interest: WakeInterest } | { ok: false; reason: string } {
    if (!req || typeof req.handle !== "string") {
      return { ok: false, reason: "wake_subscribe requires a handle string" };
    }
    const handle = normalizeHandle(req.handle);
    if (!handle) return { ok: false, reason: "wake_subscribe requires handle" };
    if (!Array.isArray(req.pathScopes) || req.pathScopes.length === 0) {
      return { ok: false, reason: "wake_subscribe requires at least one pathScope" };
    }
    const trimmedScopes = req.pathScopes.map((s) => (typeof s === "string" ? s.trim() : s));
    if (trimmedScopes.some((s) => typeof s !== "string" || s.length === 0)) {
      return { ok: false, reason: "wake_subscribe pathScope entries must be non-empty strings" };
    }
    if (req.onEvent !== undefined && req.onEvent !== "ready_for_review") {
      return { ok: false, reason: `unsupported wake event: ${req.onEvent}` };
    }
    // Last-wins: a duplicate handle overwrites the earlier interest.
    const interest: WakeInterest = { handle, pathScopes: trimmedScopes, onEvent: "ready_for_review" };
    this.interests.set(handle, interest);
    return { ok: true, interest };
  }

  unsubscribe(handle: string): boolean {
    const key = normalizeHandle(handle);
    return key ? this.interests.delete(key) : false;
  }

  get(handle: string): WakeInterest | undefined {
    const key = normalizeHandle(handle);
    if (!key) return undefined;
    const i = this.interests.get(key);
    return i ? { ...i, pathScopes: [...i.pathScopes] } : undefined;
  }

  list(): WakeInterest[] {
    return [...this.interests.values()].map((i) => ({ ...i, pathScopes: [...i.pathScopes] }));
  }

  matchForItem(item: BoardItem): WakeInterest[] {
    const out: WakeInterest[] = [];
    for (const interest of this.interests.values()) {
      if (wakeMatches(interest, item)) out.push({ ...interest, pathScopes: [...interest.pathScopes] });
    }
    return out;
  }
}
