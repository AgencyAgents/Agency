import type { HttpClient } from "@agency/net";
import type { Message, StopReason } from "@agency/schema";

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
  messages: Message[];
  tools?: ToolDefinition[];
  maxTokens: number;
  temperature?: number;
  thinkingLevel?: ThinkingLevel;
  signal?: AbortSignal;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  /** Tokens served from a provider-side cache hit, when the provider reports it. */
  cachedInputTokens?: number;
}

/**
 * Every adapter emits this shape regardless of the provider's own wire format.
 * Nothing above the adapter layer branches on a provider-specific event name.
 */
export type StreamEvent =
  | { type: "text_delta"; text: string }
  | { type: "thinking_delta"; text: string }
  | { type: "tool_call_start"; id: string; name: string }
  | { type: "tool_call_delta"; id: string; inputJsonDelta: string }
  | { type: "tool_call_end"; id: string }
  | { type: "message_stop"; stopReason: StopReason; usage: Usage };

export interface ProviderAdapter {
  readonly family: string;
  stream(request: ProviderRequest, http: HttpClient): AsyncIterable<StreamEvent>;
}
