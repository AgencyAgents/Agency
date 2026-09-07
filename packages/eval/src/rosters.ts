import type { RosterId } from "./types.ts";

/** Resolved roster: effective runner plus whether it actually executes. */
export interface ResolvedRoster {
  id: RosterId;
  writers: number;
  /** False for entries that only map, never run. All five execute since Phase 8. */
  executes: boolean;
  mapsTo?: Exclude<RosterId, "reviewer-first">;
}

/** The baseline configurations. reviewer-first runs one writer plus reviewers. */
export function resolveRoster(id: RosterId): ResolvedRoster {
  if (id === "solo") return { id, writers: 1, executes: true };
  if (id === "team") return { id, writers: 3, executes: true };
  if (id === "reviewer-first") return { id, writers: 1, executes: true };
  if (id === "fixed") return { id, writers: 3, executes: true };
  return { id, writers: 3, executes: true };
}

/** Cassettes backing the committed baseline, in report order. */
export const BASELINE_ROSTERS: RosterId[] = ["solo", "team", "reviewer-first", "fixed", "ladder"];
