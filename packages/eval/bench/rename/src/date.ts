/** YYYY-MM-DD in UTC. */
export function fmtDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}
