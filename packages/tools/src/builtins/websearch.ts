import { requireNetwork } from "@agency/guard";
import type { HttpClient } from "@agency/net";
import type { ToolDeps, ToolSpec } from "../contract.ts";
import { str, summarize } from "../render.ts";

const MAX_RESULTS_CHARS = 20_000;

export interface WebSearchConfig {
  /**
   * A GET search endpoint the query is appended to as `?q=<query>` (URL-encoded).
   * Bring-your-own: any endpoint that answers a GET with usable text results.
   * Absent config means the tool is not registered at all.
   */
  endpoint: string;
}

/**
 * Web search behind config: with `websearch.endpoint` configured the query is
 * fetched from that endpoint; without it the tool isn't part of the offered
 * set, so the model never sees an always-failing tool.
 */
export function createWebSearchTool(deps: ToolDeps, http: HttpClient, config: WebSearchConfig): ToolSpec {
  const spec: ToolSpec<{ query: string }> = {
    name: "websearch",
    description: "Searches the web via the configured search endpoint and returns the results as text.",
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
  return spec as unknown as ToolSpec;
}