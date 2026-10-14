import { createRequire } from "node:module";
import type { HttpClient } from "@agency/net";

// gpt-tokenizer embeds the full o200k_base BPE vocabulary (~80MB RSS when
// loaded). It is only needed for exact OpenAI token counts, so it is loaded
// lazily on the first count() call instead of at module import time — the
// daemon boot graph imports this module via @agency/providers and must not
// pay that cost until a turn actually needs a precise count.
const require = createRequire(import.meta.url);
let encodeFn: ((text: string) => number[]) | undefined;

function encode(text: string): number[] {
  if (!encodeFn) {
    encodeFn = (require("gpt-tokenizer") as { encode: (t: string) => number[] }).encode;
  }
  return encodeFn(text);
}

export interface Tokenizer {
  /** True BPE count vs. a calibrated approximation; callers use this to decide
   *  how much safety margin to leave before a context-window limit. */
  readonly precise: boolean;
  count(text: string): number;
}

export interface AsyncTokenizer {
  readonly precise: boolean;
  /** Marker to distinguish async tokenizers from sync ones without calling count. */
  readonly async: true;
  count(text: string): Promise<number>;
}

/** Type guard: returns true when the tokenizer's count is async. */
export function isAsyncTokenizer(t: Tokenizer | AsyncTokenizer): t is AsyncTokenizer {
  return (t as AsyncTokenizer).async === true;
}

/**
 * Real BPE tokenization via the o200k_base vocabulary (GPT-4o/GPT-5 family).
 * Use for actual OpenAI endpoints where the tokenizer is known to match.
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
 * Generic OpenAI-compatible providers may not use the exact same BPE tokenizer
 * as OpenAI. This uses a char/4 approximation as a safe offline fallback for
 * compaction thresholds and budget estimates.
 */
export function createOpenAiCompatibleTokenizer(): Tokenizer {
  return {
    precise: false,
    count(text) {
      if (text.length === 0) return 0;
      return Math.ceil(text.length / 4);
    },
  };
}

/**
 * Calibrated characters-per-token approximation for offline/budget use
 * (compaction thresholds, cost estimates before a request is sent).
 * `charsPerToken` defaults to 3.5 (Anthropic's English-prose heuristic),
 * which errs toward slightly overestimating — the safer direction for a budget.
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

/**
 * Anthropic tokenizer: uses the live count-tokens API endpoint when an HTTP
 * client and API key are provided (exact count), falling back to approximate
 * char/4 counting for offline use.
 */
export function createAnthropicTokenizer(http?: HttpClient, apiKey?: string): Tokenizer | AsyncTokenizer {
  if (http && apiKey) {
    return {
      precise: true,
      async: true as const,
      async count(text: string): Promise<number> {
        try {
          const res = await http.fetch("https://api.anthropic.com/v1/messages/count_tokens", {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-api-key": apiKey,
              "anthropic-version": "2023-06-01",
            },
            body: JSON.stringify({ messages: [{ role: "user", content: text }] }),
          });
          if (!res.ok) throw new Error(`count_tokens failed: ${res.status}`);
          const data = (await res.json()) as { input_tokens?: number };
          return data.input_tokens ?? Math.ceil(text.length / 4);
        } catch {
          return Math.ceil(text.length / 4);
        }
      },
    };
  }
  return createApproximateTokenizer(4);
}

/**
 * Google tokenizer: uses the live countTokens API endpoint when an HTTP
 * client and API key are provided (exact count), falling back to approximate
 * char/4 counting for offline use.
 */
export function createGoogleTokenizer(
  http?: HttpClient,
  apiKey?: string,
  model?: string,
): Tokenizer | AsyncTokenizer {
  if (http && apiKey) {
    return {
      precise: true,
      async: true as const,
      async count(text: string): Promise<number> {
        try {
          const url = model
            ? `https://generativelanguage.googleapis.com/v1beta/models/${model}:countTokens?key=${apiKey}`
            : `https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:countTokens?key=${apiKey}`;
          const res = await http.fetch(url, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ contents: [{ parts: [{ text }] }] }),
          });
          if (!res.ok) throw new Error(`countTokens failed: ${res.status}`);
          const data = (await res.json()) as { totalTokens?: number };
          return data.totalTokens ?? Math.ceil(text.length / 4);
        } catch {
          return Math.ceil(text.length / 4);
        }
      },
    };
  }
  return createApproximateTokenizer(4);
}

/**
 * Returns a sync Tokenizer for the given provider family. Use for offline
 * budget estimates (compaction thresholds, cost estimates before a request).
 * For exact counts, use the family-specific factories with HTTP client + key.
 */
export function tokenizerFor(family: string): Tokenizer {
  switch (family) {
    case "openai":
      return createOpenAiTokenizer();
    case "openai-compatible":
      return createOpenAiCompatibleTokenizer();
    case "anthropic":
      return createApproximateTokenizer(4);
    case "google":
      return createApproximateTokenizer(4);
    default:
      return createApproximateTokenizer();
  }
}
