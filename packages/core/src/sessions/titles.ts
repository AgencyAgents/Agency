import type { ProviderAdapter } from "@agency/providers";
import type { HttpClient } from "@agency/net";
import type { Message } from "@agency/schema";
import { parseModelRef, type Config } from "../config/schema.ts";

export function resolveSmallModel(config: Config): { provider: string; model: string } | undefined {
  const ref = config.small_model ? parseModelRef(config.small_model) : undefined;
  if (ref) return ref;
  return undefined;
}

export async function generateTitle(
  userMessage: string,
  options: {
    config: Config;
    http: HttpClient;
    providerConfig: Record<string, import("../config/schema.ts").ProviderConfig>;
    adapterFor?: (provider: string) => ProviderAdapter;
  },
): Promise<string | undefined> {
  const resolved = resolveSmallModel(options.config);
  if (!resolved) return undefined;
  const trimmed = userMessage.trim().slice(0, 500);
  if (!trimmed) return undefined;

  let adapter: ProviderAdapter;
  try {
    if (options.adapterFor) adapter = options.adapterFor(resolved.provider);
    else {
      const { createOpenAiCompatibleAdapter, anthropicAdapter, openaiAdapter, googleAdapter } = await import("@agency/providers");
      const pc = options.providerConfig[resolved.provider];
      if (pc) {
        const family = pc.family ?? "openai-compatible";
        if (family === "openai-compatible") {
          const baseUrl = pc.baseUrl ?? "";
          if (!baseUrl) return undefined;
          adapter = createOpenAiCompatibleAdapter(resolved.provider, baseUrl);
        } else if (family === "openai") adapter = openaiAdapter;
        else if (family === "anthropic") adapter = anthropicAdapter;
        else adapter = googleAdapter;
      } else {
        if (resolved.provider === "anthropic") adapter = anthropicAdapter;
        else if (resolved.provider === "openai") adapter = openaiAdapter;
        else if (resolved.provider === "google") adapter = googleAdapter;
        else return undefined;
      }
    }
  } catch {
    return undefined;
  }

  const apiKey = "title-gen";
  const messages: Message[] = [
    { role: "user", content: [{ type: "text", text: `Generate a short title (max 6 words) for this request. Reply with ONLY the title, no quotes, no punctuation prefix:\n\n${trimmed}` }] },
  ];

  try {
    let title = "";
    for await (const event of adapter.stream(
      { model: resolved.model, apiKey, messages, maxTokens: 32 },
      options.http,
    )) {
      if (event.type === "text_delta") title += event.text;
    }
    const cleaned = title.trim().split("\n")[0]?.trim().slice(0, 80) ?? "";
    return cleaned || undefined;
  } catch {
    return undefined;
  }
}

export function getSessionTitle(entries: import("./entry.ts").SessionEntry[]): string | undefined {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (e?.type === "session_title" && typeof (e as Record<string, unknown>).title === "string") {
      return (e as Record<string, unknown>).title as string;
    }
  }
  return undefined;
}
