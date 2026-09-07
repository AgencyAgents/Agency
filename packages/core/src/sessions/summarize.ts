/**
 * The shipped default summarizer for proactive compaction: purely extractive
 * and offline, so compaction never blocks on (or bills) a provider round-trip.
 * Keeps the earliest and latest lines of the transcript within a character
 * budget and elides the middle, which preserves the task's origin and the
 * work most recently in flight — the parts the kept tail of a compaction
 * doesn't already cover.
 */
export function summarizeTranscript(text: string, maxChars = 4000): string {
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => (line.length > 200 ? `${line.slice(0, 200)}…` : line));

  if (lines.length === 0) return "";

  const headBudget = Math.floor(maxChars / 2);
  const tailBudget = maxChars - headBudget;

  const head: string[] = [];
  let used = 0;
  for (const line of lines) {
    if (used + line.length > headBudget) break;
    head.push(line);
    used += line.length + 1;
  }

  const tail: string[] = [];
  used = 0;
  for (let i = lines.length - 1; i >= head.length; i--) {
    const line = lines[i];
    if (line === undefined || used + line.length > tailBudget) break;
    tail.unshift(line);
    used += line.length + 1;
  }

  const elided = lines.length - head.length - tail.length;
  if (elided <= 0) return [...head, ...tail].join("\n");
  return [...head, `[… ${elided} earlier lines elided …]`, ...tail].join("\n");
}
