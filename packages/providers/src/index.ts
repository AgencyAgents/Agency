import { anthropicAdapter } from "./adapters/anthropic.ts";
import { googleAdapter } from "./adapters/google.ts";
import { openaiAdapter } from "./adapters/openai.ts";
import { createOpenAiCompatibleAdapter } from "./adapters/openai-compatible.ts";
import { CHATGPT_USAGE_URL, chatgptAdapter, createResponsesAdapter } from "./adapters/openai-responses.ts";
import { registerAdapter, registerAdapterFactory } from "./registry.ts";

registerAdapter(anthropicAdapter);
registerAdapter(openaiAdapter);
registerAdapter(googleAdapter);
registerAdapter(chatgptAdapter);
registerAdapterFactory("openai-compatible", (family, baseUrl) =>
  createOpenAiCompatibleAdapter(family, baseUrl),
);

export * from "./auth/index.ts";
export * from "./cache-policy.ts";
export * from "./catalog/index.ts";
export * from "./catalog-cache.ts";
export * from "./cheap-router.ts";
export * from "./effort-mapping.ts";
export * from "./presets.ts";
export * from "./registry.ts";
export * from "./scheduler.ts";
export * from "./sse.ts";
export * from "./stream-recovery.ts";
export * from "./tokenizers/index.ts";
export * from "./types.ts";
export {
  anthropicAdapter,
  CHATGPT_USAGE_URL,
  chatgptAdapter,
  createOpenAiCompatibleAdapter,
  createResponsesAdapter,
  googleAdapter,
  openaiAdapter,
};
