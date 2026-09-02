import { randomUUID } from "node:crypto";
import type { CompactionThreshold, SessionStore } from "@agency/core";
import { compact, summarizeTranscript } from "@agency/core";
import {
  createApproximateTokenizer,
  type ModelPricing,
  type ThinkingLevel,
  type Tokenizer,
} from "@agency/providers";
import type { DaemonClient } from "@agency/rpc";
import { appendUsageEntry } from "@agency/telemetry";
import type { RunTurnParams, RunTurnRpcResult, SystemPromptParts } from "./daemon.ts";

export interface CompactionOptions {
  tokenizer: Tokenizer;
  threshold: CompactionThreshold;
  summarize: (text: string) => Promise<string>;
}

/**
 * Fallback context window for proactive compaction, used until a caller with
 * catalog knowledge passes `contextWindow`. 200k matches the current Claude
 * and GPT flagships; a session on a smaller-window model relies on the
 * reactive compact-and-retry path to catch the difference.
 */
export const DEFAULT_COMPACTION_CONTEXT_WINDOW = 200_000;

/**
 * Proactive compaction is on by default: an approximate tokenizer, the
 * caller's (or fallback) context window, and the offline extractive
 * summarizer, so sessions compact as they approach the window without any
 * caller opting in or any provider round-trip for the summary.
 */
export function defaultCompaction(contextWindow?: number): CompactionOptions {
  return {
    tokenizer: createApproximateTokenizer(),
    threshold: { contextWindow: contextWindow ?? DEFAULT_COMPACTION_CONTEXT_WINDOW },
    summarize: (text) => Promise.resolve(summarizeTranscript(text)),
  };
}

export interface RunSessionTurnOptions {
  store: SessionStore;
  sessionId: string;
  provider: string;
  model: string;
  systemPrompt: string;
  /** Forwarded to the daemon: compose the prompt from parts there instead. */
  systemPromptParts?: SystemPromptParts;
  userText: string;
  thinkingLevel?: ThinkingLevel;
  budget?: RunTurnParams["budget"];
  /** Context window of the active model (from the catalog when known);
   *  feeds the default proactive compaction threshold. */
  contextWindow?: number;
  compaction?: CompactionOptions;
  onEvent?: (event: unknown) => void;
  /** When set, the turn's usage is persisted as a `usage` session entry and
   *  accumulated here, feeding the cost/cache-hit-rate status line. */
  usage?: { pricing?: ModelPricing };
}

export interface RunSessionTurnResult {
  result: RunTurnRpcResult;
  /** The new branch tip after this turn (and any compaction it triggered). */
  tipId: string;
}

/**
 * One turn of a persisted, resumable session, over an already-connected
 * daemon client: loads history from the SessionStore (not from memory),
 * optionally compacts it first, appends the user's message, runs the turn,
 * then appends every message the turn produced. Each append is a separately
 * flushed JSONL line (SessionStore's guarantee), so a crash mid-turn strands
 * at most the entries that hadn't been written yet; a fresh SessionStore over
 * the same directory picks up exactly where the file left off.
 */
export async function runSessionTurn(
  client: DaemonClient,
  options: RunSessionTurnOptions,
): Promise<RunSessionTurnResult> {
  const compaction = options.compaction ?? defaultCompaction(options.contextWindow);

  const entries = options.store.load(options.sessionId);
  let tipId = options.store.latestTip(entries) ?? null;

  if (tipId) {
    const outcome = await compact(
      options.store,
      options.sessionId,
      tipId,
      compaction.tokenizer,
      compaction.threshold,
      compaction.summarize,
    );
    tipId = outcome.tipId;
  }

  const userEntry = await options.store.append(options.sessionId, {
    type: "message",
    parentId: tipId,
    message: { role: "user", content: [{ type: "text", text: options.userText }] },
  });

  let history = options.store.messagesFor(options.store.load(options.sessionId), userEntry.id);

  const turnId = randomUUID();
  // Subscribe before the request: with per-client fanout (A3) this is what
  // makes the turn's events — deltas and heartbeats — reach THIS client, and
  // arriving frames are what keep the heartbeat-aware call deadline alive.
  client.subscribe(`turn.${turnId}`);
  const unsubscribe = options.onEvent ? client.on(`turn.${turnId}`, options.onEvent) : undefined;

  try {
    const params: RunTurnParams = {
      turnId,
      provider: options.provider,
      model: options.model,
      systemPrompt: options.systemPrompt,
      systemPromptParts: options.systemPromptParts,
      thinkingLevel: options.thinkingLevel,
      session: history,
      budget: options.budget,
    };
    let result = (await client.call("run_turn", params)) as RunTurnRpcResult;

    // Compacting from userEntry.id, not the pre-turn tip: the overflowed
    // request included the user message, and the failed turn appended nothing,
    // so the append loop below stays correct against the rebuilt history.
    if (result.needsCompaction) {
      const outcome = await compact(
        options.store,
        options.sessionId,
        userEntry.id,
        compaction.tokenizer,
        compaction.threshold,
        compaction.summarize,
      );
      history = options.store.messagesFor(options.store.load(options.sessionId), outcome.tipId);
      params.session = history;
      result = (await client.call("run_turn", params)) as RunTurnRpcResult;
    }

    let parentId = userEntry.id;
    for (const message of result.messages.slice(history.length)) {
      const appended = await options.store.append(options.sessionId, { type: "message", parentId, message });
      parentId = appended.id;
    }

    if (options.usage) {
      parentId = await appendUsageEntry(options.store, options.sessionId, parentId, {
        usage: result.usage,
        model: options.model,
        pricing: options.usage.pricing,
      });
    }

    return { result, tipId: parentId };
  } finally {
    unsubscribe?.();
    client.unsubscribe(`turn.${turnId}`);
  }
}
