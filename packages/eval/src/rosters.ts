import type { RosterId } from "./types.ts";

/** Resolved roster: effective runner plus whether it actually executes. */
export interface ResolvedRoster {
  id: RosterId;
  writers: number;
  /** False for Phase 8 owned entries that only map, never run. */
  executes: boolean;
  mapsTo?: Exclude<RosterId, "reviewer-first">;
}

/** The three baseline configurations. reviewer-first maps to solo until Phase 8. */
export function resolveRoster(id: RosterId): ResolvedRoster {
  if (id === "solo") return { id, writers: 1, executes: true };
  if (id === "team") return { id, writers: 3, executes: true };
  return { id, writers: 1, executes: false, mapsTo: "solo" };
}

/** Cassettes backing the committed baseline, in report order. */
export const BASELINE_ROSTERS: Exclude<RosterId, "reviewer-first">[] = ["solo", "team"];
