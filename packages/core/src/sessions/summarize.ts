import type { HttpClient } from "@agency/net";
import type { ProviderAdapter } from "@agency/providers";
import type { Summarizer } from "./compaction.ts";

export interface ModelAsk {
  adapter: ProviderAdapter;
  http: HttpClient;
  model: string;
  apiKey: string;
  maxTokens?: number;
  signal?: AbortSignal;
}

/** One request with no tools, for the harness's own questions. Undefined for a failed request or a reply with no text. */
export async function askModel(opts: ModelAsk, system: string, text: string): Promise<string | undefined> {
  try {
    let reply = "";
    const request = {
      model: opts.model,
      apiKey: opts.apiKey,
      system,
      messages: [{ role: "user" as const, content: [{ type: "text" as const, text }] }],
      maxTokens: opts.maxTokens ?? 8192,
      ...(opts.signal === undefined ? {} : { signal: opts.signal }),
    };
    for await (const event of opts.adapter.stream(request, opts.http)) {
      if (event.type === "text_delta") reply += event.text;
    }
    return reply.trim() || undefined;
  } catch {
    return undefined;
  }
}

/**
 * A summarizer where the model writes the summary. A failed request or a reply with no text gives the
 * extractive summary: a compaction must not fail the turn that needs it.
 */
export function modelSummarizer(opts: ModelAsk): Summarizer {
  const summarize: Summarizer = async (transcript, instructions) =>
    (await askModel(opts, instructions, transcript)) ?? summarizeTranscript(transcript);
  summarize.detailed = true;
  return summarize;
}

/**
 * The offline summarizer, and the fallback of the model one: purely extractive,
 * so a compaction with it never blocks on (or bills) a provider round-trip.
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
