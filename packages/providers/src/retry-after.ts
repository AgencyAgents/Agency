/**
 * Parses HTTP `Retry-After` headers into milliseconds from now.
 * Supports three wire formats in priority order:
 * 1. `retry-after-ms` — Anthropic-style millisecond integer
 * 2. `retry-after: <seconds>` — RFC 7231 delay-seconds
 * 3. `retry-after: <HTTP-date>` — RFC 7231 absolute date
 * Returns undefined when no header is present or none of the formats parse.
 */
export function parseRetryAfterMs(res: Response): number | undefined {
  // 1. Anthropic-style retry-after-ms (non-standard but widely used)
  const msRaw = res.headers.get("retry-after-ms");
  if (msRaw) {
    const ms = Number(msRaw);
    if (Number.isFinite(ms) && ms >= 0) return Math.round(ms);
  }

  // 2. RFC 7231 delay-seconds
  const raw = res.headers.get("retry-after");
  if (!raw) return undefined;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);

  // 3. RFC 7231 HTTP-date
  const date = Date.parse(raw);
  if (Number.isFinite(date)) return Math.max(0, date - Date.now());

  return undefined;
}
