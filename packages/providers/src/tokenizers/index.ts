import { encode } from "gpt-tokenizer";

export interface Tokenizer {
  /** True BPE count vs. a calibrated approximation; callers use this to decide
   *  how much safety margin to leave before a context-window limit. */
  readonly precise: boolean;
  count(text: string): number;
}

/**
 * Real BPE tokenization via the o200k_base vocabulary (GPT-4o/GPT-5 family).
 * OpenAI-compatible providers (OpenAI itself, and most self-hosted endpoints
 * that don't publish their own tokenizer) count against this.
 */
export function createOpenAiTokenizer(): Tokenizer {
  return {
    precise: true,
    count(text) {
      return encode(text).length;
    },
  };
}

/**
 * Neither Anthropic nor Google ship an offline tokenizer: the only precise
 * count comes from their live count-tokens endpoints. This is a calibrated
 * characters-per-token approximation for offline/budget use (compaction
 * thresholds, cost estimates before a request is sent), not exact usage.
 * Anthropic's own docs put English prose around 3.5-4 chars/token; 3.5 errs
 * toward slightly overestimating, which is the safer direction for a budget.
 */
export function createApproximateTokenizer(charsPerToken = 3.5): Tokenizer {
  return {
    precise: false,
    count(text) {
      if (text.length === 0) return 0;
      return Math.ceil(text.length / charsPerToken);
    },
  };
}

export function tokenizerFor(family: string): Tokenizer {
  switch (family) {
    case "openai":
    case "openai-compatible":
      return createOpenAiTokenizer();
    case "anthropic":
    case "google":
      return createApproximateTokenizer();
    default:
      return createApproximateTokenizer();
  }
}
