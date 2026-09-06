export type SegmentStability = "shared" | "agent" | "dynamic";

export interface CacheSegment {
  stability: SegmentStability;
  text: string;
  ttlSeconds?: number;
}

export const MIN_CACHEABLE_TOKENS = 1024;
export const SHARED_PREFIX_TTL_SECONDS = 3600;
export const TAIL_TTL_SECONDS = 300;

export interface CachePolicy {
  /** Breakpoints below this size cannot pay; the adapter omits them. */
  minTokens: number;
  /** Long-lived cache for the team-shared stable prefix. */
  sharedPrefixTtlSeconds: number;
  /** Short-lived cache for the rolling conversation tail. */
  tailTtlSeconds: number;
}

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function isCacheable(text: string, minTokens: number = MIN_CACHEABLE_TOKENS): boolean {
  return estimateTokens(text) >= minTokens;
}

export function splitStableDynamic(segments: readonly CacheSegment[]): {
  stable: string;
  dynamic: string;
} {
  const stable = segments
    .filter((s) => s.stability !== "dynamic")
    .map((s) => s.text)
    .join("\n\n");
  const dynamic = segments
    .filter((s) => s.stability === "dynamic")
    .map((s) => s.text)
    .join("\n\n");
  return { stable, dynamic };
}
