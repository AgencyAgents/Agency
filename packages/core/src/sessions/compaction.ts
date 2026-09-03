import type { Tokenizer } from "@agency/providers";
import type { MessageEntry, SessionEntry } from "./entry.ts";
import { isMessageEntry, isTodoStateEntry } from "./entry.ts";

type ConcreteMessageEntry = SessionEntry & MessageEntry;

import type { SessionStore } from "./store.ts";

export interface CompactionThreshold {
  contextWindow: number;
  /** Proactive trigger as a fraction of the window; a chain already over the
   *  window (the reactive compact-and-retry case) always compacts regardless. */
  proactiveRatio?: number;
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

export function shouldCompact(tokenCount: number, threshold: CompactionThreshold): boolean {
  const ratio = threshold.proactiveRatio ?? 0.8;
  return tokenCount >= threshold.contextWindow * ratio;
}

export interface CompactionPlan {
  /** Message entries to fold into the summary, oldest first. */
  summarize: ConcreteMessageEntry[];
  /** Entries to carry forward onto the new tip unchanged: todos (wherever
   *  they fall) plus the tail kept out of the summary. */
  carryForward: SessionEntry[];
}

/** Keeps the most recent `keepLastN` messages out of the summary, and every
 *  todo_state entry regardless of position: todos are the run's task list
 *  and must never be lost to compaction. */
export function planCompaction(chain: SessionEntry[], keepLastN = 4): CompactionPlan {
  const messageIndices = chain.map((e, i) => (isMessageEntry(e) ? i : -1)).filter((i) => i >= 0);
  const cutoff =
    messageIndices.length > keepLastN ? messageIndices[messageIndices.length - keepLastN] : chain.length;
  const before = chain.slice(0, cutoff);
  const after = chain.slice(cutoff);

  return {
    summarize: before.filter(isMessageEntry),
    carryForward: [...before.filter(isTodoStateEntry), ...after],
  };
}

export interface CompactionResult {
  compacted: boolean;
  tipId: string;
}

/**
 * Compacts the branch ending at `tipId` if it's over threshold: summarizes
 * the older portion via `summarize`, then re-appends the preserved tail
 * (todos plus the last few messages) onto the new summary as a fresh tip.
 * The old chain is untouched in the file, still visible to `/tree`, just no
 * longer part of the live branch.
 */
export async function compact(
  store: SessionStore,
  sessionId: string,
  tipId: string,
  tokenizer: Tokenizer,
  threshold: CompactionThreshold,
  summarize: (text: string) => Promise<string>,
  keepLastN = 4,
): Promise<CompactionResult> {
  const entries = store.load(sessionId);
  const chain = store.chainFor(entries, tipId);
  if (!shouldCompact(countChainTokens(chain, tokenizer), threshold)) {
    return { compacted: false, tipId };
  }

  const plan = planCompaction(chain, keepLastN);
  if (plan.summarize.length === 0) {
    return { compacted: false, tipId };
  }

  const summaryText = await summarize(plan.summarize.map((e) => JSON.stringify(e.message)).join("\n"));
  const summaryEntry = await store.append(sessionId, {
    type: "compaction_summary",
    parentId: null,
    summary: summaryText,
    replacedEntryIds: plan.summarize.map((e) => e.id),
  });

  let parentId: string = summaryEntry.id;
  for (const entry of plan.carryForward) {
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
    const bus = (store as unknown as { bus?: { emit: (e: string, p: unknown) => void } }).bus;
    bus?.emit("session.compacted", { sessionId, tipId: parentId });
    bus?.emit("event", { event: "session.compacted", payload: { sessionId, tipId: parentId } });
  } catch {}

  return { compacted: true, tipId: parentId };
}
