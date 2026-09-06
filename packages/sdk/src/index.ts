import { randomUUID } from "node:crypto";
import { connectToDaemon, type DaemonClient, PROVIDERS_LIST_METHOD } from "@agency/rpc";
import type { Message, StopReason } from "@agency/schema";

export type { DaemonClient } from "@agency/rpc";
export { connectToDaemon } from "@agency/rpc";
export type { ContentBlock, ImageBlock, Message, StopReason } from "@agency/schema";
export * from "./generated.ts";

import { createSurfaceClient, type SurfaceClient } from "./generated.ts";

/**
 * The SDK's own view of the daemon's wire contract (R12: versioned SDK types).
 * Structurally compatible with what the daemon's run_turn handler accepts;
 * the RPC layer validates nothing beyond the transport, so a mismatch here is
 * a runtime error at the daemon by design: the SDK is a thin client, not a
 * second schema.
 */
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export interface Budget {
  maxTokens?: number;
  maxCostUsd?: number;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens?: number;
}

export interface RunTurnParams {
  /** Generated when omitted, so callers can correlate events without pre-planning ids. */
  turnId?: string;
  provider: string;
  model: string;
  /**
   * Optional (A3): the daemon resolves the key from its own env/keychain, so
   * credentials no longer need to cross the wire. Send one explicitly only
   * for keys the daemon cannot see (rare).
   */
  apiKey?: string;
  systemPrompt: string;
  thinkingLevel?: ThinkingLevel;
  session: Message[];
  budget?: Budget;
  maxToolIterations?: number;
  images?: import("@agency/schema").ImageBlock[];
}

export interface RunTurnResult {
  messages: Message[];
  stopReason: StopReason;
  usage: Usage;
  budgetExceeded: boolean;
  cancelled: boolean;
}

export type TurnEvent =
  | { type: "text_delta"; text: string }
  | { type: "thinking_delta"; text: string }
  | { type: "tool_start"; id: string; name: string; input?: Record<string, unknown> }
  | {
      type: "tool_result";
      id: string;
      content: string;
      isError: boolean;
      images?: Array<{ type: "image"; mimeType: string; data: string }>;
    }
  | { type: "turn_complete"; stopReason: StopReason; usage: Usage }
  | { type: "budget_exceeded"; spentTokens: number; spentCostUsd: number };

export interface ProviderModelSummary {
  id: string;
  name: string;
  pricing: { inputPerMTok: number; outputPerMTok: number; cachedInputPerMTok?: number };
  contextWindow: number;
  capabilities: { tools: boolean; vision: boolean; thinking: boolean };
  status?: "alpha" | "beta" | "deprecated" | "active";
  releaseDate?: string;
}

export interface ProviderSummary {
  id: string;
  name: string;
  models: ProviderModelSummary[];
}

export interface ProvidersListResult {
  all: ProviderSummary[];
  default: Record<string, string>;
  connected: string[];
}

export interface AgencyClient {
  runTurn(params: RunTurnParams, onEvent?: (event: TurnEvent) => void): Promise<RunTurnResult>;
  cancelTurn(turnId: string): Promise<{ cancelled: boolean }>;
  listProviders(): Promise<ProvidersListResult>;
  /** Every RPC method from /doc, over this client's transport. */
  surface: SurfaceClient;
  call(method: string, params: unknown, timeoutMs?: number): Promise<unknown>;
  on(event: string, handler: (payload: unknown) => void): () => void;
  close(): Promise<void>;
}

/** Wraps a raw daemon connection with the typed turn surface. */
export function createAgencyClient(client: DaemonClient): AgencyClient {
  return {
    async runTurn(params, onEvent) {
      const turnId = params.turnId ?? randomUUID();
      // Subscribe before the request so the turn's events (and their
      // deadline-refreshing activity) reach this client from the first delta.
      client.subscribe(`turn.${turnId}`);
      const unsubscribe = onEvent
        ? client.on(`turn.${turnId}`, (payload) => onEvent(payload as TurnEvent))
        : undefined;
      try {
        return (await client.call("run_turn", { ...params, turnId })) as RunTurnResult;
      } finally {
        unsubscribe?.();
        client.unsubscribe(`turn.${turnId}`);
      }
    },

    async cancelTurn(turnId) {
      return (await client.call("cancel_turn", { turnId })) as { cancelled: boolean };
    },

    async listProviders() {
      return (await client.call(PROVIDERS_LIST_METHOD, {})) as ProvidersListResult;
    },

    surface: createSurfaceClient((method, params) => client.call(method, params)),

    call: (method, params, timeoutMs) => client.call(method, params, timeoutMs),
    on: (event, handler) => client.on(event, handler),
    close: () => client.close(),
  };
}

/** Connects to a running daemon (version handshake included) as an AgencyClient. */
export async function connect(port: number, host = "127.0.0.1"): Promise<AgencyClient> {
  return createAgencyClient(await connectToDaemon(port, host));
}
