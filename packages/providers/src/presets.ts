import { anthropicAdapter } from "./adapters/anthropic.ts";
import { openaiAdapter } from "./adapters/openai.ts";
import { googleAdapter } from "./adapters/google.ts";
import { createOpenAiCompatibleAdapter } from "./adapters/openai-compatible.ts";
import type { ProviderAdapter } from "./types.ts";

export type CacheStrategy =
  /** Agency marks explicit breakpoints in the request (Anthropic's cache_control). */
  | "explicit-breakpoints"
  /** The provider caches automatically server-side; nothing for Agency to mark. */
  | "automatic";

export interface FamilyPreset {
  readonly family: string;
  readonly adapter: ProviderAdapter;
  readonly cacheStrategy: CacheStrategy;
  /** True if streamed tool calls can interleave by index (OpenAI); false if
   *  each call arrives complete and self-contained (Anthropic, Google). */
  readonly streamsParallelToolCallDeltas: boolean;
}

export const anthropicPreset: FamilyPreset = {
  family: "anthropic",
  adapter: anthropicAdapter,
  cacheStrategy: "explicit-breakpoints",
  streamsParallelToolCallDeltas: false,
};

export const openaiPreset: FamilyPreset = {
  family: "openai",
  adapter: openaiAdapter,
  cacheStrategy: "automatic",
  streamsParallelToolCallDeltas: true,
};

export const googlePreset: FamilyPreset = {
  family: "google",
  adapter: googleAdapter,
  cacheStrategy: "automatic",
  streamsParallelToolCallDeltas: false,
};

/** For self-hosted/gateway endpoints (Ollama, OpenRouter, Groq, vLLM, ...). */
export function createOpenAiCompatiblePreset(family: string, baseUrl: string): FamilyPreset {
  return {
    family,
    adapter: createOpenAiCompatibleAdapter(family, baseUrl),
    cacheStrategy: "automatic",
    streamsParallelToolCallDeltas: true,
  };
}

export const builtinPresets: readonly FamilyPreset[] = [anthropicPreset, openaiPreset, googlePreset];
