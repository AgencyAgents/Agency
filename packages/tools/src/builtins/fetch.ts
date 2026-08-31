import { requireNetwork } from "@agency/guard";
import type { HttpClient } from "@agency/net";
import type { ToolDeps, ToolSpec } from "../contract.ts";

const MAX_FETCH_CHARS = 50_000;

export function createFetchTool(deps: ToolDeps, http: HttpClient): ToolSpec {
  const spec: ToolSpec<{ url: string }> = {
    name: "fetch",
    description: "Fetches a URL over HTTP(S) and returns its body as text.",
    inputSchema: {
      type: "object",
      properties: { url: { type: "string" } },
      required: ["url"],
    },
    riskTier: "moderate",
    renderCall: (input) => `fetch ${input.url}`,

    async handler(input) {
      const host = new URL(input.url).hostname;
      requireNetwork(deps.identity, deps.capabilities, host);

      const res = await http.fetch(input.url);
      const body = await res.text();

      if (!res.ok) {
        return { content: `${res.status} ${res.statusText}: ${body.slice(0, 500)}`, isError: true };
      }

      const truncated = body.length > MAX_FETCH_CHARS;
      const content = truncated ? body.slice(0, MAX_FETCH_CHARS) : body;
      return { content: truncated ? `${content}\n[truncated at ${MAX_FETCH_CHARS} characters]` : content };
    },
  };
  return spec as unknown as ToolSpec;
}
