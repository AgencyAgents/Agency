import type { AsyncTokenizer, Tokenizer } from "@agency/providers";
import { isAsyncTokenizer } from "@agency/providers";
import { ErrorCode } from "@agency/schema";
import { compactionPrompt } from "../prompt/compaction.ts";
import type { MessageEntry, SessionEntry } from "./entry.ts";
import { isItemStateEntry, isMessageEntry, isTodoStateEntry } from "./entry.ts";

type ConcreteMessageEntry = SessionEntry & MessageEntry;

import type { SessionStore } from "./store.ts";

/** Proactive trigger: compact once chain tokens reach this fraction of the window. */
export const COMPACTION_TRIGGER_RATIO = 0.9;
/** Target: expansion folds messages until the new chain fits this fraction. */
export const COMPACTION_TARGET_RATIO = 0.7;
/** Hard cap on stored summary size, in tokens. */
export const SUMMARY_CAP_TOKENS = 20_000;
/** Hard cap on transcript chunks per summarize pass. */
export const MAX_SUMMARY_CHUNKS = 8;
/** Hard cap on re-summarize passes while chasing the target. */
export const MAX_TARGET_PASSES = 3;

export interface CompactionThreshold {
  contextWindow: number;
  /** Proactive trigger fraction; a forced compaction skips this check. */
  proactiveRatio?: number;
  /** Post-compaction target fraction of the window. */
  targetRatio?: number;
  /** Stored summary cap in tokens. */
  summaryCapTokens?: number;
}

/** Trigger level in tokens for a threshold. */
export function triggerTokens(threshold: CompactionThreshold): number {
  return threshold.contextWindow * (threshold.proactiveRatio ?? COMPACTION_TRIGGER_RATIO);
}

/** Target level in tokens for a threshold. */
export function targetTokens(threshold: CompactionThreshold): number {
  return threshold.contextWindow * (threshold.targetRatio ?? COMPACTION_TARGET_RATIO);
}

/** Summary cap in tokens for a threshold. */
export function summaryCapTokens(threshold: CompactionThreshold): number {
  return threshold.summaryCapTokens ?? SUMMARY_CAP_TOKENS;
}

export function countChainTokens(chain: SessionEntry[], tokenizer: Tokenizer): number {
  let total = 0;
  for (const entry of chain) {
    if (isMessageEntry(entry)) {
      for (const block of entry.message.content) {
        if (block.type === "text" || block.type === "thinking") total += tokenizer.count(block.text);
        else if (block.type === "tool_result") total += tokenizer.count(block.content);
        else if (block.type === "tool_call") total += tokenizer.count(JSON.stringify(block.input));
        else if (block.type === "redacted_thinking") total += tokenizer.count(block.data);
      }
    } else if (entry.type === "compaction_summary" && typeof entry.summary === "string") {
      total += tokenizer.count(entry.summary);
    }
  }
  return total;
}

/** Async variant of countChainTokens: exact when the tokenizer is async, sync otherwise. */
export async function countChainTokensAsync(
  chain: SessionEntry[],
  tokenizer: Tokenizer | AsyncTokenizer,
): Promise<number> {
  if (!isAsyncTokenizer(tokenizer)) {
    return countChainTokens(chain, tokenizer);
  }
  let total = 0;
  for (const entry of chain) {
    if (isMessageEntry(entry)) {
      for (const block of entry.message.content) {
        if (block.type === "text" || block.type === "thinking") total += await tokenizer.count(block.text);
        else if (block.type === "tool_result") total += await tokenizer.count(block.content);
        else if (block.type === "tool_call") total += await tokenizer.count(JSON.stringify(block.input));
        else if (block.type === "redacted_thinking") total += await tokenizer.count(block.data);
      }
    } else if (entry.type === "compaction_summary" && typeof entry.summary === "string") {
      total += await tokenizer.count(entry.summary);
    }
  }
  return total;
}

export function shouldCompact(tokenCount: number, threshold: CompactionThreshold): boolean {
  return tokenCount >= triggerTokens(threshold);
}

export interface CompactionPlan {
  /** Message entries to fold into the summary, oldest first. */
  summarize: ConcreteMessageEntry[];
  /** Entries carried onto the new tip unchanged: todos plus the kept tail. */
  carryForward: SessionEntry[];
}

/** Keeps the most recent `keepLastN` messages out of the summary, and every
 *  todo_state plus item_state entry regardless of position: task lists and
 *  item contracts must never be lost to compaction. */
export function planCompaction(chain: SessionEntry[], keepLastN = 4): CompactionPlan {
  const messageIndices = chain.map((e, i) => (isMessageEntry(e) ? i : -1)).filter((i) => i >= 0);
  const cutoff =
    messageIndices.length > keepLastN ? messageIndices[messageIndices.length - keepLastN] : chain.length;
  const before = chain.slice(0, cutoff);
  const after = chain.slice(cutoff);

  return {
    summarize: before.filter(isMessageEntry),
    carryForward: [...before.filter((e) => isTodoStateEntry(e) || isItemStateEntry(e)), ...after],
  };
}

export interface CollapsedTranscript {
  text: string;
  /** The kept assistant texts, verbatim and in order. */
  verbatimAssistantTexts: string[];
  collapsedToolPairs: number;
  strippedAttachments: number;
}

/** Stage one: deterministic collapse. Old tool pairs fold to one line each,
 *  stale image attachments are stripped, and only the most recent assistant
 *  texts survive verbatim. User texts stay readable, truncated to 200 chars. */
export function collapseTranscript(chain: SessionEntry[], keepAssistantTexts = 3): CollapsedTranscript {
  const messages = chain.filter(isMessageEntry);
  const assistantIdx: number[] = [];
  messages.forEach((entry, i) => {
    if (entry.message.role === "assistant" && entry.message.content.some((b) => b.type === "text")) {
      assistantIdx.push(i);
    }
  });
  const firstKept =
    assistantIdx.length > keepAssistantTexts ? assistantIdx[assistantIdx.length - keepAssistantTexts] : 0;
  const cutoff = firstKept ?? 0;

  const lines: string[] = [];
  const verbatimAssistantTexts: string[] = [];
  let collapsedToolPairs = 0;
  let strippedAttachments = 0;
  messages.forEach((entry, i) => {
    if (i >= cutoff) {
      for (const block of entry.message.content) {
        if (block.type === "text" && entry.message.role === "assistant")
          verbatimAssistantTexts.push(block.text);
        else if (block.type === "image") strippedAttachments += 1;
        else if (block.type === "tool_result" && block.images) strippedAttachments += block.images.length;
      }
      lines.push(`[${entry.message.role}] ${JSON.stringify(entry.message.content)}`);
      return;
    }
    for (const block of entry.message.content) {
      if (block.type === "text") {
        if (entry.message.role === "assistant")
          lines.push(`[assistant text folded: ${block.text.length} chars]`);
        else lines.push(block.text.length > 200 ? `${block.text.slice(0, 200)}...` : block.text);
      } else if (block.type === "thinking" || block.type === "redacted_thinking") {
        lines.push("[thinking folded]");
      } else if (block.type === "tool_call") {
        collapsedToolPairs += 1;
        lines.push(`[tool ${block.name} collapsed]`);
      } else if (block.type === "tool_result") {
        lines.push(`[tool result collapsed: ${block.content.length} chars]`);
        if (block.images) strippedAttachments += block.images.length;
      } else if (block.type === "image") {
        strippedAttachments += 1;
      }
    }
  });
  return { text: lines.join("\n"), verbatimAssistantTexts, collapsedToolPairs, strippedAttachments };
}

const CONTRACT_RE = /\[Compacted: \d+ turns -> \d+ sections\]\s*$/;

/** The output contract suffix for a summary of `turns` folded into `sections`. */
export function outputContractSuffix(turns: number, sections: number): string {
  return `\n[Compacted: ${turns} turns -> ${sections} sections]`;
}

/** Appends the output contract line unless the summary already ends with one. */
export function ensureOutputContract(summary: string, turns: number, sections: number): string {
  if (CONTRACT_RE.test(summary)) return summary;
  return `${summary}${outputContractSuffix(turns, sections)}`;
}

/** Cuts text to `cap` tokens (sync count), keeping a head plus a marker. */
export function truncateSummaryToCap(
  summary: string,
  count: (text: string) => number,
  cap: number = SUMMARY_CAP_TOKENS,
): string {
  return truncateWithMarker(summary, count, cap, `\n[truncated to ${cap} tokens]`);
}

function truncateWithMarker(
  text: string,
  count: (text: string) => number,
  cap: number,
  marker: string,
): string {
  if (count(text) <= cap) return text;
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = Math.floor((lo + hi + 1) / 2);
    if (count(text.slice(0, mid) + marker) <= cap) lo = mid;
    else hi = mid - 1;
  }
  return text.slice(0, lo) + marker;
}

/** Cap enforcement with the tokenizer source of truth: async exact count
 *  when the tokenizer is async, sync count otherwise. */
export async function truncateSummaryToCapForTokenizer(
  summary: string,
  tokenizer: Tokenizer | AsyncTokenizer,
  cap: number = SUMMARY_CAP_TOKENS,
): Promise<string> {
  if (!isAsyncTokenizer(tokenizer)) {
    return truncateSummaryToCap(summary, (text) => tokenizer.count(text), cap);
  }
  const marker = `\n[truncated to ${cap} tokens]`;
  if ((await tokenizer.count(summary)) <= cap) return summary;
  let lo = 0;
  let hi = summary.length;
  while (lo < hi) {
    const mid = Math.floor((lo + hi + 1) / 2);
    if ((await tokenizer.count(summary.slice(0, mid) + marker)) <= cap) lo = mid;
    else hi = mid - 1;
  }
  return summary.slice(0, lo) + marker;
}

/** Splits a transcript into line-preserving chunks that each fit `cap`
 *  tokens, hard-capped at `maxChunks` with the overflow elided by marker. */
export function splitTranscriptToCap(
  transcript: string,
  count: (text: string) => number,
  cap: number = SUMMARY_CAP_TOKENS,
  maxChunks: number = MAX_SUMMARY_CHUNKS,
): string[] {
  if (transcript.length === 0) return [];
  const lines = transcript.split("\n");
  const chunks: string[] = [];
  let current: string[] = [];
  const push = (): void => {
    if (current.length > 0) chunks.push(current.join("\n"));
    current = [];
  };
  let dropped = 0;
  for (const line of lines) {
    if (chunks.length === maxChunks) {
      dropped += 1;
      continue;
    }
    if (count(line) > cap) {
      push();
      if (chunks.length === maxChunks) {
        dropped += 1;
        continue;
      }
      const step = Math.max(1, Math.floor((line.length * cap) / Math.max(1, count(line))));
      for (let i = 0; i < line.length; i += step) {
        if (chunks.length === maxChunks) {
          dropped += Math.ceil((line.length - i) / step);
          break;
        }
        chunks.push(line.slice(i, i + step));
      }
      continue;
    }
    if (current.length > 0 && count([...current, line].join("\n")) > cap) {
      push();
      if (chunks.length === maxChunks) {
        dropped += 1;
        continue;
      }
    }
    current.push(line);
  }
  push();
  if (dropped > 0 && chunks.length > 0) {
    const last = chunks[chunks.length - 1];
    if (last !== undefined) {
      chunks[chunks.length - 1] = truncateWithMarker(
        last,
        count,
        cap,
        `\n[... ${dropped} lines beyond hard cap elided ...]`,
      );
    }
  }
  return chunks.slice(0, maxChunks);
}

async function splitTranscriptToCapAsync(
  transcript: string,
  count: (text: string) => number | Promise<number>,
  cap: number,
  maxChunks: number = MAX_SUMMARY_CHUNKS,
): Promise<string[]> {
  const syncish = async (text: string): Promise<number> => count(text);
  if (transcript.length === 0) return [];
  const lines = transcript.split("\n");
  const chunks: string[] = [];
  let current: string[] = [];
  const push = (): void => {
    if (current.length > 0) chunks.push(current.join("\n"));
    current = [];
  };
  let dropped = 0;
  for (const line of lines) {
    if (chunks.length === maxChunks) {
      dropped += 1;
      continue;
    }
    if ((await syncish(line)) > cap) {
      push();
      if (chunks.length === maxChunks) {
        dropped += 1;
        continue;
      }
      const lineCount = await syncish(line);
      const step = Math.max(1, Math.floor((line.length * cap) / Math.max(1, lineCount)));
      for (let i = 0; i < line.length; i += step) {
        if (chunks.length === maxChunks) {
          dropped += Math.ceil((line.length - i) / step);
          break;
        }
        chunks.push(line.slice(i, i + step));
      }
      continue;
    }
    if (current.length > 0 && (await syncish([...current, line].join("\n"))) > cap) {
      push();
      if (chunks.length === maxChunks) {
        dropped += 1;
        continue;
      }
    }
    current.push(line);
  }
  push();
  if (dropped > 0 && chunks.length > 0) {
    const last = chunks[chunks.length - 1];
    if (last !== undefined) {
      const marker = `\n[... ${dropped} lines beyond hard cap elided ...]`;
      if ((await syncish(last)) > cap) {
        let lo = 0;
        let hi = last.length;
        while (lo < hi) {
          const mid = Math.floor((lo + hi + 1) / 2);
          if ((await syncish(last.slice(0, mid) + marker)) <= cap) lo = mid;
          else hi = mid - 1;
        }
        chunks[chunks.length - 1] = last.slice(0, lo) + marker;
      } else {
        chunks[chunks.length - 1] = last + marker;
      }
    }
  }
  return chunks.slice(0, maxChunks);
}

async function truncateHeadToCap(
  text: string,
  count: (text: string) => number | Promise<number>,
  budget: number,
): Promise<string> {
  if ((await count(text)) <= budget) return text;
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = Math.floor((lo + hi + 1) / 2);
    if ((await count(text.slice(0, mid))) <= budget) lo = mid;
    else hi = mid - 1;
  }
  return text.slice(0, lo);
}
export function isContextOverflowError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  return (error as { code?: unknown }).code === ErrorCode.CONTEXT_OVERFLOW;
}

export interface CompactionResult {
  compacted: boolean;
  tipId: string;
}

/**
 * Two-stage compaction for the branch ending at `tipId`: deterministic
 * collapse first, then an agentic summary via the compaction prompt. The
 * summarize window expands until the new chain fits the 70 percent target.
 */
export async function compact(
  store: SessionStore,
  sessionId: string,
  tipId: string,
  tokenizer: Tokenizer | AsyncTokenizer,
  threshold: CompactionThreshold,
  summarize: (text: string) => Promise<string>,
  keepLastN = 4,
  opts: { force?: boolean } = {},
): Promise<CompactionResult> {
  const entries = store.load(sessionId);
  const chain = store.chainFor(entries, tipId);
  const tokenCount = await countChainTokensAsync(chain, tokenizer);
  if (!opts.force && !shouldCompact(tokenCount, threshold)) {
    return { compacted: false, tipId };
  }

  const plan = planCompaction(chain, keepLastN);
  if (plan.summarize.length === 0) {
    return { compacted: false, tipId };
  }

  const cap = summaryCapTokens(threshold);
  const target = targetTokens(threshold);
  const prompt = compactionPrompt();
  const countText = (text: string): number | Promise<number> =>
    isAsyncTokenizer(tokenizer) ? tokenizer.count(text) : tokenizer.count(text);
  const summarized = new Set(plan.summarize.map((e) => e.id));
  let carryForward = plan.carryForward;
  let summaryText = "";
  let passes = 0;

  for (;;) {
    passes += 1;
    const summarizeSet = chain.filter((e) => summarized.has(e.id)).filter(isMessageEntry);
    const collapsed = collapseTranscript(summarizeSet);
    const chunks = await splitTranscriptToCapAsync(collapsed.text, countText, cap);
    const parts: string[] = [];
    for (const chunk of chunks) {
      parts.push(await summarize(`${prompt}\n\n${chunk}`));
    }
    const rawDigest = parts.join("\n");
    const digest = CONTRACT_RE.test(rawDigest) ? rawDigest.replace(CONTRACT_RE, "").trimEnd() : rawDigest;
    const suffix = outputContractSuffix(summarizeSet.length, parts.length);
    const suffixTokens = await countText(suffix);
    let body = digest;
    if ((await countText(digest + suffix)) > cap) {
      body = await truncateHeadToCap(digest, countText, Math.max(0, cap - suffixTokens));
    }
    summaryText = `${body}${suffix}`;
    const probe: SessionEntry = {
      id: "probe",
      parentId: null,
      schemaVersion: 1,
      createdAt: "",
      type: "compaction_summary",
      summary: summaryText,
      replacedEntryIds: [...summarized],
    };
    const probeCount = await countChainTokensAsync([probe, ...carryForward], tokenizer);
    if (probeCount <= target) break;
    const movable = carryForward.filter(isMessageEntry);
    if (passes > MAX_TARGET_PASSES || movable.length <= 1) break;
    const oldest = movable[0];
    if (oldest === undefined) break;
    summarized.add(oldest.id);
    carryForward = plan.carryForward.filter((e) => !summarized.has(e.id));
  }

  const summaryEntry = await store.append(sessionId, {
    type: "compaction_summary",
    parentId: null,
    summary: summaryText,
    replacedEntryIds: [...summarized],
  });

  let parentId: string = summaryEntry.id;
  for (const entry of carryForward) {
    const {
      id: _id,
      parentId: _parentId,
      createdAt: _createdAt,
      schemaVersion: _schemaVersion,
      ...rest
    } = entry;
    const appended = await store.append(sessionId, { ...rest, parentId });
    parentId = appended.id;
  }

  try {
    const bus = store.getBus?.();
    bus?.emit("session.compacted", { sessionId, tipId: parentId });
    bus?.emit("event", { event: "session.compacted", payload: { sessionId, tipId: parentId } });
  } catch {}

  return { compacted: true, tipId: parentId };
}
