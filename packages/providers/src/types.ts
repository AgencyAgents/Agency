import type { HttpClient } from "@agency/net";
import type { Message, StopReason } from "@agency/schema";
import type { CachePolicy, CacheSegment } from "./cache-policy.ts";

/** Unified across every provider's native reasoning-effort knob (Pi's scale). */
export const ThinkingLevel = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ThinkingLevel = (typeof ThinkingLevel)[number];

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>; // JSON Schema, provider-agnostic
}

export interface ProviderRequest {
  model: string;
  apiKey: string;
  system?: string;
  /** Ordered composer segments; adapters with explicit breakpoints consume these. */
  systemSegments?: CacheSegment[];
  /** Minimum cacheable size; defaults to the active policy when absent. */
  cachePolicy?: CachePolicy;
  messages: Message[];
  tools?: ToolDefinition[];
  maxTokens: number;
  temperature?: number;
  thinkingLevel?: ThinkingLevel;
  /** Overrides the adapter's native endpoint: gateways, proxies, self-hosted. */
  baseUrl?: string;
  /** Extra headers merged over the adapter's own (auth headers stay). */
  headers?: Record<string, string>;
  signal?: AbortSignal;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  /** Tokens served from a provider-side cache hit, when the provider reports it. */
  cachedInputTokens?: number;
  /** Tokens written to the provider-side cache at the write premium. */
  cacheWriteInputTokens?: number;
}

/**
 * Every adapter emits this shape regardless of the provider's own wire format.
 * Nothing above the adapter layer branches on a provider-specific event name.
 */
export type StreamEvent =
  | { type: "text_delta"; text: string }
  | { type: "thinking_delta"; text: string }
  | { type: "thinking_signature"; signature: string }
  | { type: "redacted_thinking"; data: string }
  | { type: "tool_call_start"; id: string; name: string }
  | { type: "tool_call_delta"; id: string; inputJsonDelta: string }
  | { type: "tool_call_end"; id: string }
  | { type: "message_stop"; stopReason: StopReason; usage: Usage };

export interface ProviderAdapter {
  readonly family: string;
  stream(request: ProviderRequest, http: HttpClient): AsyncIterable<StreamEvent>;
}
