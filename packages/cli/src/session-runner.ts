import { randomUUID } from "node:crypto";
import type { PermissionMode } from "@agency/guard";
import type { ThinkingLevel } from "@agency/providers";
import type { DaemonClient } from "@agency/rpc";
import type { ImageBlock } from "@agency/schema";
import type { RunTurnParams, RunTurnRpcResult, SessionSendResult, SystemPromptParts } from "./daemon.ts";

export interface RunSessionTurnOptions {
  sessionId: string;
  provider: string;
  model: string;
  systemPrompt: string;
  /** Forwarded to the daemon: compose the prompt from parts there instead. */
  systemPromptParts?: SystemPromptParts;
  userText: string;
  images?: ImageBlock[];
  thinkingLevel?: ThinkingLevel;
  budget?: RunTurnParams["budget"];
  /** Context window of the active model; feeds daemon-side compaction. */
  contextWindow?: number;
  permissionMode?: PermissionMode;
  /** Headless turns refuse asks at once instead of waiting on a responder. */
  nonInteractive?: boolean;
  /** Caller-supplied for pre-subscribe streaming; generated when absent. */
  turnId?: string;
  onEvent?: (event: unknown) => void;
}

export interface RunSessionTurnResult {
  result: RunTurnRpcResult;
  /** The new branch tip after this turn (and any compaction it triggered). */
  tipId: string;
}

/** Thin consumer over session_send: the daemon owns the SessionStore,
 *  rebuilds history, compacts, appends, and records usage. The client sends
 *  text and streams events, keeping no session logic of its own. */
export async function runSessionTurn(
  client: DaemonClient,
  options: RunSessionTurnOptions,
): Promise<RunSessionTurnResult> {
  const turnId = options.turnId ?? randomUUID();
  // Subscribe before the request: with per-client fanout (A3) this is what
  // makes the turn's events reach THIS client.
  client.subscribe(`turn.${turnId}`);
  const unsubscribe = options.onEvent ? client.on(`turn.${turnId}`, options.onEvent) : undefined;

  try {
    const response = (await client.call("session_send", {
      turnId,
      sessionId: options.sessionId,
      provider: options.provider,
      model: options.model,
      systemPrompt: options.systemPrompt,
      systemPromptParts: options.systemPromptParts,
      userText: options.userText,
      thinkingLevel: options.thinkingLevel,
      budget: options.budget,
      contextWindow: options.contextWindow,
      permissionMode: options.permissionMode,
      nonInteractive: options.nonInteractive,
      ...(options.images?.length ? { images: options.images } : {}),
    })) as SessionSendResult;
    const { sessionId: _sessionId, turnId: _turnId, tipId, compacted: _compacted, ...result } = response;
    return { result, tipId };
  } finally {
    unsubscribe?.();
    client.unsubscribe(`turn.${turnId}`);
  }
}
