import { createOpenAiCompatibleAdapter } from "./openai-compatible.ts";

export const openaiAdapter = createOpenAiCompatibleAdapter("openai", "https://api.openai.com/v1");
