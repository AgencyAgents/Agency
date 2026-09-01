import { randomUUID } from "node:crypto";
import type { CompactionThreshold, SessionStore } from "@agency/core";
import { compact } from "@agency/core";
import type { ModelPricing, ThinkingLevel, Tokenizer } from "@agency/providers";
import type { DaemonClient } from "@agency/rpc";
import { appendUsageEntry } from "@agency/telemetry";
import type { RunTurnParams, RunTurnRpcResult } from "./daemon.ts";

export interface CompactionOptions {
  tokenizer: Tokenizer;
  threshold: CompactionThreshold;
  summarize: (text: string) => Promise<string>;
}

export interface RunSessionTurnOptions {
  store: SessionStore;
  sessionId: string;
  provider: string;
  model: string;
  apiKey: string;
  systemPrompt: string;
  userText: string;
  thinkingLevel?: ThinkingLevel;
  budget?: RunTurnParams["budget"];
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
  const entries = options.store.load(options.sessionId);
  let tipId = options.store.latestTip(entries) ?? null;

  if (options.compaction && tipId) {
    const outcome = await compact(
      options.store,
      options.sessionId,
      tipId,
      options.compaction.tokenizer,
      options.compaction.threshold,
      options.compaction.summarize,
    );
    tipId = outcome.tipId;
  }

  const userEntry = options.store.append(options.sessionId, {
    type: "message",
    parentId: tipId,
    message: { role: "user", content: [{ type: "text", text: options.userText }] },
  });

  const history = options.store.messagesFor(options.store.load(options.sessionId), userEntry.id);

  const turnId = randomUUID();
  const unsubscribe = options.onEvent ? client.on(`turn.${turnId}`, options.onEvent) : undefined;

  try {
    const params: RunTurnParams = {
      turnId,
      provider: options.provider,
      model: options.model,
      apiKey: options.apiKey,
      systemPrompt: options.systemPrompt,
      thinkingLevel: options.thinkingLevel,
      session: history,
      budget: options.budget,
    };
    const result = (await client.call("run_turn", params)) as RunTurnRpcResult;

    let parentId = userEntry.id;
    for (const message of result.messages.slice(history.length)) {
      const appended = options.store.append(options.sessionId, { type: "message", parentId, message });
      parentId = appended.id;
    }

    if (options.usage) {
      parentId = appendUsageEntry(options.store, options.sessionId, parentId, {
        usage: result.usage,
        model: options.model,
        pricing: options.usage.pricing,
      });
    }

    return { result, tipId: parentId };
  } finally {
    unsubscribe?.();
  }
}
