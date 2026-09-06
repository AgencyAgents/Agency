import { anthropicAdapter } from "./adapters/anthropic.ts";
import { googleAdapter } from "./adapters/google.ts";
import { openaiAdapter } from "./adapters/openai.ts";
import { createOpenAiCompatibleAdapter } from "./adapters/openai-compatible.ts";
import type { CachePolicy } from "./cache-policy.ts";
import type { ProviderAdapter } from "./types.ts";

export const ANTHROPIC_CACHE_POLICY: CachePolicy = {
  minTokens: 1024,
  sharedPrefixTtlSeconds: 3600,
  tailTtlSeconds: 300,
};

export const AUTOMATIC_CACHE_POLICY: CachePolicy = {
  minTokens: 1024,
  sharedPrefixTtlSeconds: 3600,
  tailTtlSeconds: 300,
};

export interface FamilyPreset {
  readonly family: string;
  readonly adapter: ProviderAdapter;
  readonly cachePolicy: CachePolicy;
  /** True if streamed tool calls can interleave by index (OpenAI); false if
   *  each call arrives complete and self-contained (Anthropic, Google). */
  readonly streamsParallelToolCallDeltas: boolean;
}

export const anthropicPreset: FamilyPreset = {
  family: "anthropic",
  adapter: anthropicAdapter,
  cachePolicy: ANTHROPIC_CACHE_POLICY,
  streamsParallelToolCallDeltas: false,
};

export const openaiPreset: FamilyPreset = {
  family: "openai",
  adapter: openaiAdapter,
  cachePolicy: AUTOMATIC_CACHE_POLICY,
  streamsParallelToolCallDeltas: true,
};

export const googlePreset: FamilyPreset = {
  family: "google",
  adapter: googleAdapter,
  cachePolicy: AUTOMATIC_CACHE_POLICY,
  streamsParallelToolCallDeltas: false,
};

/** For self-hosted/gateway endpoints (Ollama, OpenRouter, Groq, vLLM, ...). */
export function createOpenAiCompatiblePreset(family: string, baseUrl: string): FamilyPreset {
  return {
    family,
    adapter: createOpenAiCompatibleAdapter(family, baseUrl),
    cachePolicy: AUTOMATIC_CACHE_POLICY,
    streamsParallelToolCallDeltas: true,
  };
}

export const builtinPresets: readonly FamilyPreset[] = [anthropicPreset, openaiPreset, googlePreset];
