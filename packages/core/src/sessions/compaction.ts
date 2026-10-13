import type { AsyncTokenizer, Tokenizer } from "@agency/providers";
import { isAsyncTokenizer } from "@agency/providers";
import { ErrorCode, type Message } from "@agency/schema";
import { HookBlock } from "../events.ts";
import { compactionPrompt } from "../prompt/compaction.ts";
import type { MessageEntry, SessionEntry } from "./entry.ts";
import { isCompactionSummaryEntry, isItemStateEntry, isMessageEntry, isTodoStateEntry } from "./entry.ts";

type ConcreteMessageEntry = SessionEntry & MessageEntry;

import { compactionSummaryMessage, type SessionStore } from "./store.ts";

/** Proactive trigger: compact once chain tokens reach this fraction of the window. */
export const COMPACTION_TRIGGER_RATIO = 0.9;
/** Target: expansion folds messages until the new chain fits this fraction. */
export const COMPACTION_TARGET_RATIO = 0.7;
/**
 * The trigger never goes above this size. Each request sends the whole history again, so a large window that fills
 * costs much more than the work it holds; a measured optimum was near 220k tokens (LangWatch, 873 compactions).
 */
export const COMPACTION_LIMIT_TOKENS = 220_000;
/** The newest messages that a summary leaves word for word: this share of the target, and at most this size. */
const TAIL_TARGET_SHARE = 0.4;
const TAIL_MAX_TOKENS = 40_000;
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
  /** `compactionLimit` of the config: the trigger in tokens for a window that is larger. */
  limitTokens?: number;
  /** Post-compaction target fraction of the window. */
  targetRatio?: number;
  /** Stored summary cap in tokens. */
  summaryCapTokens?: number;
}

/** Trigger level in tokens for a threshold. */
export function triggerTokens(threshold: CompactionThreshold): number {
  return Math.min(
    threshold.contextWindow * (threshold.proactiveRatio ?? COMPACTION_TRIGGER_RATIO),
    threshold.limitTokens ?? COMPACTION_LIMIT_TOKENS,
  );
}

/** Target level in tokens for a threshold. */
export function targetTokens(threshold: CompactionThreshold): number {
  // In proportion to the trigger: the two keep their distance when the token limit sets the trigger.
  const target = threshold.targetRatio ?? COMPACTION_TARGET_RATIO;
  const limit = threshold.limitTokens ?? COMPACTION_LIMIT_TOKENS;
  return Math.min(
    threshold.contextWindow * target,
    (limit * target) / (threshold.proactiveRatio ?? COMPACTION_TRIGGER_RATIO),
  );
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

function hasToolResult(entry: SessionEntry | undefined): boolean {
  return (
    entry !== undefined &&
    isMessageEntry(entry) &&
    entry.message.content.some((b) => b.type === "tool_result")
  );
}

/** Keeps the most recent `keepLastN` messages out of the summary, and every
 *  todo_state plus item_state entry regardless of position: task lists and
 *  item contracts must never be lost to compaction. */
export function planCompaction(chain: SessionEntry[], keepLastN = 4): CompactionPlan {
  const messageIndices = chain.map((e, i) => (isMessageEntry(e) ? i : -1)).filter((i) => i >= 0);
  let first = messageIndices.length - keepLastN;
  // A tool result stays with its call: providers reject a request that opens with a result.
  while (first > 0 && hasToolResult(chain[messageIndices[first] as number])) first -= 1;
  const cutoff = messageIndices.length > keepLastN ? messageIndices[first] : chain.length;
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

const cutTo = (text: string, max: number): string =>
  text.length > max ? `${text.slice(0, max)}… [${text.length - max} more chars]` : text;

/** The transcript for a summarizer that reads: texts in full, tool inputs, the start of each tool result. No thinking. */
export function renderTranscript(messages: Message[]): string {
  const lines: string[] = [];
  for (const message of messages) {
    for (const block of message.content) {
      if (block.type === "text") lines.push(`[${message.role}] ${block.text}`);
      else if (block.type === "tool_call")
        lines.push(`[tool call] ${block.name} ${cutTo(JSON.stringify(block.input), 400)}`);
      else if (block.type === "tool_result")
        lines.push(`[tool result${block.isError ? ", error" : ""}] ${cutTo(block.content, 600)}`);
      else if (block.type === "image") lines.push("[image]");
    }
  }
  return lines.join("\n");
}

const CONTRACT_RE = /\[Compacted: \d+ turns? -> \d+ sections?\]\s*$/;

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
 * Turns one transcript chunk into summary text. The instructions come apart from the chunk:
 * an extractive summarizer would copy them into the summary, and the model reads that as a user message.
 * `detailed` is for a summarizer that reads, a model: its transcript keeps tool inputs and results.
 */
export type Summarizer = ((transcript: string, instructions: string) => Promise<string>) & {
  detailed?: boolean;
};

/** The store-free half of compact: which entries fold into the summary, its text, and what stays. */
export const USER_MESSAGES_MARKER = "[the user's messages, word for word]";
const USER_MESSAGES_MAX_TOKENS = 20_000;
const USER_MESSAGE_MAX_CHARS = 4_000;

/**
 * The texts that the user wrote in the folded part, newest kept first up to a token budget. A summary can lose or
 * change a rule of the user: these lines stay as written, also through later compactions.
 */
async function userMessagesBlock(
  earlierSummaries: string[],
  folded: MessageEntry[],
  countText: (text: string) => number | Promise<number>,
  budget: number,
): Promise<string> {
  const texts: string[] = [];
  // A summary of an earlier compaction holds the lines of that time: they go on.
  for (const summary of earlierSummaries) {
    const marker = summary.indexOf(USER_MESSAGES_MARKER);
    if (marker === -1) continue;
    const lines = summary.slice(marker + USER_MESSAGES_MARKER.length).split("\n- ");
    texts.push(...lines.map((line) => line.replace(CONTRACT_RE, "").trim()).filter(Boolean));
  }
  for (const entry of folded) {
    if (entry.message.role !== "user") continue;
    for (const block of entry.message.content) {
      if (block.type !== "text" || block.text.trim() === "") continue;
      const cut = block.text.length > USER_MESSAGE_MAX_CHARS;
      texts.push(cut ? `${block.text.slice(0, USER_MESSAGE_MAX_CHARS)} [cut]` : block.text.trim());
    }
  }
  const kept: string[] = [];
  let used = 0;
  for (const item of texts.reverse()) {
    const cost = await countText(item);
    if (used + cost > budget) break;
    used += cost;
    kept.unshift(item);
  }
  return kept.length === 0 ? "" : `\n\n${USER_MESSAGES_MARKER}\n- ${kept.join("\n- ")}`;
}

async function foldChain(
  chain: SessionEntry[],
  tokenizer: Tokenizer | AsyncTokenizer,
  threshold: CompactionThreshold,
  summarize: Summarizer,
  keepLastN: number,
): Promise<{ summaryText: string; summarized: Set<string>; carryForward: SessionEntry[] } | undefined> {
  const target = targetTokens(threshold);
  // A short summary alone makes the model find its place again: the newest messages stay word for word up to a budget.
  const tailBudget = Math.min(TAIL_MAX_TOKENS, target * TAIL_TARGET_SHARE);
  const all = chain.filter(isMessageEntry);
  let tail = 0;
  for (let used = 0; tail < all.length; tail++) {
    used += await countChainTokensAsync([all[all.length - 1 - tail] as SessionEntry], tokenizer);
    if (used > tailBudget) break;
  }
  // The budget does not apply when it would leave nothing to fold.
  const plan = planCompaction(chain, tail < all.length ? Math.max(keepLastN, tail) : keepLastN);
  if (plan.summarize.length === 0) return undefined;

  const cap = summaryCapTokens(threshold);
  const prompt = compactionPrompt();
  const countText = (text: string): number | Promise<number> =>
    isAsyncTokenizer(tokenizer) ? tokenizer.count(text) : tokenizer.count(text);
  const summarized = new Set(plan.summarize.map((e) => e.id));
  let carryForward = plan.carryForward;
  let summaryText = "";
  let passes = 0;
  // A call moves with its results, and at least one message stays.
  const moveOldest = (): boolean => {
    const movable = carryForward.filter(isMessageEntry);
    let take = 1;
    while (take < movable.length && hasToolResult(movable[take])) take += 1;
    if (take >= movable.length) return false;
    for (const entry of movable.slice(0, take)) summarized.add(entry.id);
    carryForward = plan.carryForward.filter((e) => !summarized.has(e.id));
    return true;
  };
  // A pass is a request when a model summarizes: the kept tail is cut to the target before the first one.
  if (summarize.detailed) {
    while ((await countChainTokensAsync(carryForward, tokenizer)) > target && moveOldest()) {}
  }

  for (;;) {
    passes += 1;
    const summarizeSet = chain.filter((e) => summarized.has(e.id)).filter(isMessageEntry);
    const transcript = summarize.detailed
      ? renderTranscript(summarizeSet.map((entry) => entry.message))
      : collapseTranscript(summarizeSet).text;
    const chunks = await splitTranscriptToCapAsync(transcript, countText, cap);
    const parts: string[] = [];
    for (const chunk of chunks) {
      parts.push(await summarize(chunk, prompt));
    }
    const rawDigest = parts.join("\n");
    const digest = CONTRACT_RE.test(rawDigest) ? rawDigest.replace(CONTRACT_RE, "").trimEnd() : rawDigest;
    const userBlock = await userMessagesBlock(
      chain.filter(isCompactionSummaryEntry).map((entry) => entry.summary),
      summarizeSet,
      countText,
      Math.min(USER_MESSAGES_MAX_TOKENS, Math.floor(target / 10)),
    );
    const suffix = `${userBlock}${outputContractSuffix(summarizeSet.length, parts.length)}`;
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
    if (passes > MAX_TARGET_PASSES || !moveOldest()) break;
  }
  return { summaryText, summarized, carryForward };
}

// A result at most this long stays: the marker would save nothing.
const ELIDE_MIN_CHARS = 400;

/**
 * The stage before a summary, with no model call: old tool results become one line each, and the newest stay up to
 * `keepTokens`. Gives the new chain and the index of its first changed entry, or undefined when nothing changed.
 */
async function elideOldToolResults(
  chain: SessionEntry[],
  countText: (text: string) => number | Promise<number>,
  keepTokens: number,
): Promise<{ chain: SessionEntry[]; first: number } | undefined> {
  const out = [...chain];
  let kept = 0;
  let first = -1;
  // In the middle of a turn the newest results have no answer yet: the model has not read them, so they stay.
  const lastAnswer = chain.findLastIndex((e) => isMessageEntry(e) && e.message.role === "assistant");
  for (let i = chain.length - 1; i >= 0; i--) {
    const entry = chain[i];
    if (entry === undefined || !isMessageEntry(entry)) continue;
    let changed = false;
    const content: Message["content"] = [];
    for (const block of entry.message.content) {
      if (block.type === "tool_result" && block.content.length > ELIDE_MIN_CHARS) {
        if (kept <= keepTokens) kept += await countText(block.content);
        if (kept > keepTokens && i < lastAnswer) {
          const { images: _images, ...rest } = block;
          const chars = block.content.length;
          content.push({
            ...rest,
            content: `[output removed to save context: ${chars} chars. Run the tool again if you need it.]`,
          });
          changed = true;
          continue;
        }
      }
      content.push(block);
    }
    if (!changed) continue;
    out[i] = { ...entry, message: { ...entry.message, content } };
    first = i;
  }
  return first === -1 ? undefined : { chain: out, first };
}

/** The chain after the removal stage, when that alone brings it to the target. */
async function elideToTarget(
  chain: SessionEntry[],
  tokenizer: Tokenizer | AsyncTokenizer,
  threshold: CompactionThreshold,
): Promise<{ chain: SessionEntry[]; first: number } | undefined> {
  const target = targetTokens(threshold);
  const countText = (text: string): number | Promise<number> =>
    isAsyncTokenizer(tokenizer) ? tokenizer.count(text) : tokenizer.count(text);
  // Half of the target for results: the texts and the tool inputs need the rest.
  const elided = await elideOldToolResults(chain, countText, target / 2);
  if (elided === undefined) return undefined;
  return (await countChainTokensAsync(elided.chain, tokenizer)) <= target ? elided : undefined;
}

/** compact() for a transcript with no store behind it. Undefined when there is nothing to fold. */
export async function compactMessages(
  messages: Message[],
  tokenizer: Tokenizer | AsyncTokenizer,
  threshold: CompactionThreshold,
  summarize: Summarizer,
  keepLastN = 4,
): Promise<Message[] | undefined> {
  const chain = messages.map(
    (message, i): SessionEntry => ({
      id: String(i),
      parentId: i === 0 ? null : String(i - 1),
      schemaVersion: 1,
      createdAt: "",
      type: "message",
      message,
    }),
  );
  const elided = await elideToTarget(chain, tokenizer, threshold);
  if (elided !== undefined) return elided.chain.filter(isMessageEntry).map((entry) => entry.message);
  const folded = await foldChain(chain, tokenizer, threshold, summarize, keepLastN);
  if (folded === undefined) return undefined;
  return [
    compactionSummaryMessage({ summary: folded.summaryText }),
    ...folded.carryForward.filter(isMessageEntry).map((entry) => entry.message),
  ];
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
  summarize: Summarizer,
  keepLastN = 4,
  opts: { force?: boolean; trigger?: "manual" | "auto" } = {},
): Promise<CompactionResult> {
  const entries = store.load(sessionId);
  const chain = store.chainFor(entries, tipId);
  const tokenCount = await countChainTokensAsync(chain, tokenizer);
  if (!opts.force && !shouldCompact(tokenCount, threshold)) {
    return { compacted: false, tipId };
  }
  // A PreCompact hook can refuse the compaction.
  const trigger = opts.trigger ?? "auto";
  const asked = await store.getBus?.()?.emitCollect?.("session.compacting", { sessionId, trigger });
  if (asked?.errors.some((error) => error instanceof HookBlock)) return { compacted: false, tipId };

  /** Appends the entries as a new branch on `from`, and gives its tip. */
  const rebase = async (from: string | null, moved: SessionEntry[]): Promise<string | null> => {
    let parent = from;
    for (const entry of moved) {
      const {
        id: _id,
        parentId: _parentId,
        createdAt: _createdAt,
        schemaVersion: _schemaVersion,
        ...rest
      } = entry;
      parent = (await store.append(sessionId, { ...rest, parentId: parent })).id;
    }
    return parent;
  };
  // A person who asks for a compaction wants the summary.
  const elided = trigger === "manual" ? undefined : await elideToTarget(chain, tokenizer, threshold);
  let parentId: string;
  if (elided !== undefined) {
    // The entries before the first changed one stay as they are: the new branch starts there.
    const from = elided.chain[elided.first]?.parentId ?? null;
    parentId = (await rebase(from, elided.chain.slice(elided.first))) ?? tipId;
  } else {
    const folded = await foldChain(chain, tokenizer, threshold, summarize, keepLastN);
    if (folded === undefined) return { compacted: false, tipId };
    const summaryEntry = await store.append(sessionId, {
      type: "compaction_summary",
      parentId: null,
      summary: folded.summaryText,
      replacedEntryIds: [...folded.summarized],
    });
    parentId = (await rebase(summaryEntry.id, folded.carryForward)) ?? summaryEntry.id;
  }

  try {
    const bus = store.getBus?.();
    bus?.emit("session.compacted", { sessionId, tipId: parentId, trigger });
    bus?.emit("event", { event: "session.compacted", payload: { sessionId, tipId: parentId, trigger } });
  } catch {}

  return { compacted: true, tipId: parentId };
}
