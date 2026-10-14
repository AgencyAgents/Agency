import { requireNetwork } from "@agency/guard";
import type { HttpClient } from "@agency/net";
import type { ToolDeps, ToolSpec } from "../contract.ts";
import { str, summarize } from "../render.ts";

const MAX_RESULTS_CHARS = 20_000;
/** Of each result: enough to judge the page, which the model can then `fetch` whole. */
const EXCERPT_CHARS = 1_500;

export type WebSearchConfig =
  /** A GET search endpoint the query is appended to as `?q=<query>` (URL-encoded). */
  | { endpoint: string }
  /**
   * No endpoint: the web plugin of OpenRouter, with the key of the openrouter provider. One search of 5 results
   * cost about 1 cent (measured 0.0072 USD for 3).
   */
  | { openrouter: { baseUrl: string; model: string; apiKey: () => Promise<string | undefined> } };

interface Citation {
  type?: string;
  url_citation?: { url?: string; title?: string; content?: string };
}

/** Searches with OpenRouter's web plugin; the results are the `url_citation` annotations of its answer. */
async function openRouterSearch(
  query: string,
  config: Extract<WebSearchConfig, { openrouter: unknown }>["openrouter"],
  http: HttpClient,
  deps: ToolDeps,
): Promise<{ content: string; isError?: true }> {
  const url = `${config.baseUrl.replace(/\/+$/, "")}/chat/completions`;
  requireNetwork(deps.identity, deps.capabilities, new URL(url).hostname);
  const key = await config.apiKey();
  if (!key) return { content: "websearch needs the key of the openrouter provider", isError: true };
  const res = await http.fetch(url, {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({
      model: config.model,
      messages: [{ role: "user", content: query }],
      plugins: [{ id: "web", max_results: 5 }],
      // The results come as annotations: the text of the model is not needed.
      max_tokens: 16,
    }),
  });
  const body = (await res.json().catch(() => ({}))) as {
    error?: { message?: string };
    choices?: { message?: { annotations?: Citation[] } }[];
  };
  if (!res.ok) {
    return { content: `${res.status} ${res.statusText}: ${body.error?.message ?? ""}`.trim(), isError: true };
  }
  const hits = (body.choices?.[0]?.message?.annotations ?? []).filter((a) => a.type === "url_citation");
  if (hits.length === 0) return { content: "(no results)" };
  return {
    content: hits
      .map((hit, i) => {
        const excerpt = (hit.url_citation?.content ?? "").replace(/\s+/g, " ").trim().slice(0, EXCERPT_CHARS);
        return `${i + 1}. ${hit.url_citation?.title ?? ""}\n   ${hit.url_citation?.url ?? ""}\n   ${excerpt}`;
      })
      .join("\n\n"),
  };
}

/**
 * Web search: from `websearch.endpoint` when configured, otherwise through OpenRouter. With neither the tool is not
 * part of the offered set, so the model never sees an always-failing tool.
 */
export function createWebSearchTool(deps: ToolDeps, http: HttpClient, config: WebSearchConfig): ToolSpec {
  const spec: ToolSpec<{ query: string }> = {
    name: "websearch",
    description:
      "Searches the web and returns the top results: for each, the title, the URL and an excerpt. Use fetch for a whole page.",
    inputSchema: {
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
    },
    riskTier: "moderate",
    renderCall: (input) => `websearch ${summarize(str(input.query))}`,
    renderResult: (result) =>
      result.isError
        ? `websearch failed: ${summarize(result.content)}`
        : `websearch: ${summarize(result.content) || "(no results)"}`,

    async handler(input) {
      const query = str(input.query).trim();
      if (query.length === 0) {
        return { content: "websearch requires a non-empty query", isError: true };
      }
      if ("openrouter" in config) return openRouterSearch(query, config.openrouter, http, deps);

      const url = `${config.endpoint}${config.endpoint.includes("?") ? "&" : "?"}q=${encodeURIComponent(query)}`;
      requireNetwork(deps.identity, deps.capabilities, new URL(url).hostname);

      const res = await http.fetch(url);
      const body = await res.text();
      if (!res.ok) {
        return { content: `${res.status} ${res.statusText}: ${body.slice(0, 500)}`, isError: true };
      }
      const content = body.length > MAX_RESULTS_CHARS ? body.slice(0, MAX_RESULTS_CHARS) : body;
      return { content };
    },
  };
  return spec;
}
