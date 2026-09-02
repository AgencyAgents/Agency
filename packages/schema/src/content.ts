import { z } from "zod";

/** Provider-agnostic message content. Every adapter normalizes into these blocks. */
export const TextBlock = z.object({
  type: z.literal("text"),
  text: z.string(),
});

export const ThinkingBlock = z.object({
  type: z.literal("thinking"),
  text: z.string(),
  /** Some providers return a signature that must be replayed verbatim on the next turn. */
  signature: z.string().optional(),
});

/**
 * Providers occasionally replace reasoning with an encrypted payload they can
 * verify later (Anthropic `redacted_thinking`): it is never displayed or
 * interpreted, only replayed verbatim so the conversation stays resumable.
 */
export const RedactedThinkingBlock = z.object({
  type: z.literal("redacted_thinking"),
  data: z.string(),
});

export const ToolCallBlock = z.object({
  type: z.literal("tool_call"),
  id: z.string(),
  name: z.string(),
  input: z.record(z.string(), z.unknown()),
});

export const ImageBlock = z.object({
  type: z.literal("image"),
  mimeType: z.string(),
  data: z.string(), // base64
});

export const ToolResultBlock = z.object({
  type: z.literal("tool_result"),
  toolCallId: z.string(),
  content: z.string(),
  isError: z.boolean().default(false),
  /** Images the tool read (P7 image input); replayed to vision-capable models. */
  images: z.array(ImageBlock).optional(),
});

export const ContentBlock = z.discriminatedUnion("type", [
  TextBlock,
  ThinkingBlock,
  RedactedThinkingBlock,
  ToolCallBlock,
  ToolResultBlock,
  ImageBlock,
]);

export type TextBlock = z.infer<typeof TextBlock>;
export type ThinkingBlock = z.infer<typeof ThinkingBlock>;
export type RedactedThinkingBlock = z.infer<typeof RedactedThinkingBlock>;
export type ToolCallBlock = z.infer<typeof ToolCallBlock>;
export type ToolResultBlock = z.infer<typeof ToolResultBlock>;
export type ImageBlock = z.infer<typeof ImageBlock>;
export type ContentBlock = z.infer<typeof ContentBlock>;

export const Role = z.enum(["user", "assistant", "system"]);
export type Role = z.infer<typeof Role>;

export const Message = z.object({
  role: Role,
  content: z.array(ContentBlock),
});
export type Message = z.infer<typeof Message>;

/**
 * Normalized across providers: their native stop/finish reasons collapse into these.
 * Adapters own the mapping; nothing downstream branches on a provider-specific string.
 */
export const StopReason = z.enum([
  "end_turn",
  "tool_use",
  "max_tokens",
  "stop_sequence",
  "refusal",
  "cancelled",
  "error",
]);
export type StopReason = z.infer<typeof StopReason>;
