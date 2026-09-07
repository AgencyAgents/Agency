import { AgencyError, ErrorCode } from "@agency/schema";
import type { ApprovalRequest, RequestApproval } from "./approval.ts";

/**
 * How hard a reasoning effort level is expected to burn output tokens,
 * relative to a baseline. Used only for pre-dispatch cost ranges — a rough
 * multiplier is exactly right for a gate whose job is to make a $40 fan-out
 * visible before it starts, not to bill accurately.
 */
export const EFFORT_OUTPUT_MULTIPLIER: Readonly<Record<string, number>> = {
  off: 1,
  minimal: 1,
  low: 1.5,
  medium: 2,
  high: 3,
  xhigh: 4,
  max: 5,
};

export interface DispatchAgentForecast {
  model: string;
  inputPerMTok: number;
  outputPerMTok: number;
  effort?: string;
}

export interface CostEstimate {
  lowUsd: number;
  highUsd: number;
  agentCount: number;
}

/** Per-agent input-token overhead beyond the brief itself (system prompt + tool definitions + scaffolding). */
const INPUT_OVERHEAD_TOKENS = 4_000;
const OUTPUT_LOW_TOKENS = 1_000;
const OUTPUT_HIGH_TOKENS = 4_000;

/**
 * Pre-dispatch cost forecast: a LOW..HIGH dollar range from the brief length,
 * each target agent's model pricing, and its resolved effort level. Before any
 * agent is spawned, this range is what the approval surface shows.
 */
export function estimateDispatchCost(params: {
  briefChars: number;
  agents: readonly DispatchAgentForecast[];
}): CostEstimate {
  const briefTokens = Math.ceil(params.briefChars / 4);
  let lowUsd = 0;
  let highUsd = 0;
  for (const agent of params.agents) {
    const inputTokens = briefTokens + INPUT_OVERHEAD_TOKENS;
    const multiplier = EFFORT_OUTPUT_MULTIPLIER[agent.effort ?? "medium"] ?? 2;
    const low =
      (inputTokens / 1_000_000) * agent.inputPerMTok +
      ((OUTPUT_LOW_TOKENS * multiplier) / 1_000_000) * agent.outputPerMTok;
    const high =
      ((inputTokens * 2) / 1_000_000) * agent.inputPerMTok +
      ((OUTPUT_HIGH_TOKENS * multiplier) / 1_000_000) * agent.outputPerMTok;
    lowUsd += low;
    highUsd += high;
  }
  return { lowUsd, highUsd, agentCount: params.agents.length };
}

/** Single-turn pre-flight estimate from prompt size and model pricing. */
export function estimateTurnCostUsd(params: {
  promptChars: number;
  inputPerMTok: number;
  outputPerMTok: number;
  effort?: string;
}): CostEstimate {
  const inputTokens = Math.ceil(params.promptChars / 4) + INPUT_OVERHEAD_TOKENS;
  const multiplier = EFFORT_OUTPUT_MULTIPLIER[params.effort ?? "medium"] ?? 2;
  return {
    lowUsd:
      (inputTokens / 1_000_000) * params.inputPerMTok +
      ((OUTPUT_LOW_TOKENS * multiplier) / 1_000_000) * params.outputPerMTok,
    highUsd:
      ((inputTokens * 2) / 1_000_000) * params.inputPerMTok +
      ((OUTPUT_HIGH_TOKENS * multiplier) / 1_000_000) * params.outputPerMTok,
    agentCount: 1,
  };
}

/**
 * The forecast gate, shaped like every other approval: when the HIGH end of
 * the estimate exceeds the configured threshold, the dispatch must be approved
 * through the same once/always/reject surface as a dangerous command — with
 * the number attached. No approval surface available (headless) or the user
 * rejects: PERMISSION_DENIED, and nothing has been spawned.
 */
export async function checkCostForecast(params: {
  estimate: CostEstimate;
  thresholdUsd?: number;
  ask?: RequestApproval;
  /** Tool name reported in the approval request; defaults to "dispatch". */
  tool?: string;
}): Promise<void> {
  const { estimate, thresholdUsd, ask } = params;
  if (thresholdUsd === undefined || estimate.highUsd <= thresholdUsd) return;

  const summary = `estimated cost $${estimate.lowUsd.toFixed(2)}–$${estimate.highUsd.toFixed(2)} for ${estimate.agentCount} agent(s)`;
  const request: ApprovalRequest = {
    tool: params.tool ?? "dispatch",
    title: summary,
    metadata: {
      estimate: { lowUsd: estimate.lowUsd, highUsd: estimate.highUsd, agentCount: estimate.agentCount },
    },
  };

  if (!ask) {
    throw new AgencyError(
      ErrorCode.PERMISSION_DENIED,
      `dispatch forecast ${summary} exceeds the ${thresholdUsd.toFixed(2)} USD threshold and no approval surface is available`,
      { source: "forecast", context: { estimate } },
    );
  }
  const response = await ask(request);
  if (response === "reject") {
    throw new AgencyError(
      ErrorCode.PERMISSION_DENIED,
      `dispatch rejected: forecast ${summary} exceeded the ${thresholdUsd.toFixed(2)} USD threshold`,
      { source: "forecast", context: { estimate } },
    );
  }
}
