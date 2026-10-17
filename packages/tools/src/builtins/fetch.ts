import { requireNetwork } from "@agency/guard";
import { t } from "@agency/i18n";
import type { HttpClient } from "@agency/net";
import type { ToolDeps, ToolSpec } from "../contract.ts";
import { extractHtmlTitle, htmlToMarkdown } from "../html.ts";
import { clip, str, summarize } from "../render.ts";

const MAX_FETCH_CHARS = 50_000;
const MAX_REDIRECTS = 10;

/**
 * Turns a raw HTTP body into model-readable text: HTML gets title + a
 * markdown-ish conversion, anything else passes through. Conversion output
 * that comes back empty falls back to the raw body rather than inventing a
 * blank result.
 */
function bodyToText(body: string, contentType: string): string {
  if (!contentType.includes("text/html")) return body;
  const title = extractHtmlTitle(body);
  const markdown = htmlToMarkdown(body);
  if (markdown.length === 0) return body;
  return title !== undefined ? `# ${title}\n\n${markdown}` : markdown;
}

export function createFetchTool(deps: ToolDeps, http: HttpClient): ToolSpec {
  const spec: ToolSpec<{ url: string }> = {
    name: "fetch",
    description:
      "Fetches a URL over HTTP(S) and returns its body as text. HTML responses are converted to " +
      "readable markdown (title, headings, links, lists); other content types return the raw body.",
    inputSchema: {
      type: "object",
      properties: { url: { type: "string" } },
      required: ["url"],
    },
    riskTier: "moderate",
    readOnly: () => true,
    renderCall: (input) => `fetch ${summarize(str(input.url))}`,
    renderResult: (result) => {
      const url = str(result.input?.url);
      const label = url ? `fetch ${url}` : "fetch";
      if (result.isError) return `${label} failed: ${summarize(result.content)}`;
      const body = clip(result.content) || "(empty body)";
      return `${label}: ${result.content.length} chars (${body})`;
    },

    async handler(input) {
      let url = new URL(input.url);
      requireNetwork(deps.identity, deps.capabilities, url.hostname);
      // A redirect to another host comes back as a note, as in Claude Code: the next call to that host passes the
      // permission and network checks of its own. Followed blindly, an allowed host could lead to any other.
      let res = await http.fetch(url.href, { redirect: "manual" });
      for (let hops = 0; res.status >= 300 && res.status < 400 && res.headers.has("location"); hops++) {
        const next = new URL(res.headers.get("location") ?? "", url);
        if (next.host !== url.host || next.protocol !== url.protocol || hops === MAX_REDIRECTS) {
          return { content: t("tool.fetch.redirect", { url: input.url, location: next.href }) };
        }
        url = next;
        res = await http.fetch(url.href, { redirect: "manual" });
      }
      const body = await res.text();

      if (!res.ok) {
        return { content: `${res.status} ${res.statusText}: ${body.slice(0, 500)}`, isError: true };
      }

      const contentType = res.headers.get("content-type") ?? "";
      const text = bodyToText(body, contentType);

      const truncated = text.length > MAX_FETCH_CHARS;
      const content = truncated ? text.slice(0, MAX_FETCH_CHARS) : text;
      return {
        content: truncated ? `${content}\n${t("tool.fetch.truncated", { chars: MAX_FETCH_CHARS })}` : content,
      };
    },
  };
  return spec;
}
