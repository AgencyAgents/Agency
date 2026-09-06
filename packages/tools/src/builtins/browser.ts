import { requireNetwork } from "@agency/guard";
import { t } from "@agency/i18n";
import type { HttpClient } from "@agency/net";
import type { ToolDeps, ToolSpec } from "../contract.ts";
import { decodeEntities, extractHtmlTitle, htmlToMarkdown } from "../html.ts";
import { clip, str, summarize } from "../render.ts";

const MAX_BROWSER_CHARS = 50_000;
const MAX_BROWSER_BYTES = 1_000_000;
const MAX_SNAPSHOT_HEADINGS = 100;
const MAX_SNAPSHOT_LINKS = 200;

export type BrowserAction = "navigate" | "snapshot" | "screenshot" | "close";

type BrowserInput = {
  action: BrowserAction;
  url?: string;
};

interface StoredPage {
  url: string;
  html: string;
  readTruncated: boolean;
}

function isFileUrl(raw: string): boolean {
  const trimmed = raw.trim().toLowerCase();
  if (trimmed.startsWith("file:")) return true;
  try {
    return new URL(raw).protocol === "file:";
  } catch {
    return false;
  }
}

function stripTags(text: string): string {
  return decodeEntities(text.replace(/<[^>]+>/g, ""))
    .replace(/\s+/g, " ")
    .trim();
}

function extractHeadings(html: string): { level: number; text: string }[] {
  const out: { level: number; text: string }[] = [];
  const re = /<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi;
  let m: RegExpExecArray | null = re.exec(html);
  while (m !== null && out.length < MAX_SNAPSHOT_HEADINGS) {
    const text = stripTags(m[2] ?? "");
    if (text.length > 0) out.push({ level: Number.parseInt(m[1] ?? "1", 10), text });
    m = re.exec(html);
  }
  return out;
}

function extractLinks(html: string): { text: string; href: string }[] {
  const out: { text: string; href: string }[] = [];
  const re = /<a\b[^>]*href=["']([^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m: RegExpExecArray | null = re.exec(html);
  while (m !== null && out.length < MAX_SNAPSHOT_LINKS) {
    const href = (m[1] ?? "").trim();
    if (href.length === 0) {
      m = re.exec(html);
      continue;
    }
    out.push({ text: stripTags(m[2] ?? "") || href, href });
    m = re.exec(html);
  }
  return out;
}

function buildSnapshot(url: string, html: string): string {
  const title = extractHtmlTitle(html);
  const headings = extractHeadings(html);
  const links = extractLinks(html);
  const lines: string[] = [`URL: ${url}`, `Title: ${title ?? "(no title)"}`];
  lines.push(`Headings (${headings.length}):`);
  lines.push(...headings.map((h) => `  [h${h.level}] ${h.text}`));
  lines.push(`Links (${links.length}):`);
  lines.push(...links.map((l) => `  [${l.text}](${l.href})`));
  lines.push("Text:");
  lines.push(htmlToMarkdown(html) || "(empty body)");
  return lines.join("\n");
}

function cap(text: string, truncated: boolean): { content: string; capped: boolean } {
  if (text.length <= MAX_BROWSER_CHARS) return { content: text, capped: truncated };
  const slice = text.slice(0, MAX_BROWSER_CHARS);
  return { content: `${slice}\n${t("tool.browser.truncated", { chars: MAX_BROWSER_CHARS })}`, capped: true };
}

/**
 * Zero-dependency browser minimum: navigate + snapshot over fetch + regex
 * HTML parsing (no chromium bundled). `screenshot` intentionally returns an
 * informative denial; a real headless capture is a future upgrade (e.g.
 * puppeteer/playwright — deliberately NOT added here to keep zero-dep).
 */
export function createBrowserTool(deps: ToolDeps, http: HttpClient): ToolSpec {
  let current: StoredPage | null = null;

  const spec: ToolSpec<BrowserInput> = {
    name: "browser",
    description:
      "Headless-browser minimum without bundled chromium: navigate fetches a page over HTTP(S), " +
      "snapshot returns an accessibility-tree-like view (title, headings, links, text), close discards " +
      "the page. Screenshots are unavailable in this build (use snapshot).",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["navigate", "snapshot", "screenshot", "close"] },
        url: { type: "string", description: "Required for navigate." },
      },
      required: ["action"],
    },
    riskTier: "moderate",
    renderCall: (input) => {
      const url = str(input.url);
      return url ? `browser ${str(input.action)} ${summarize(url)}` : `browser ${str(input.action)}`;
    },
    renderResult: (result) => {
      const action = str(result.input?.action);
      const label = action ? `browser ${action}` : "browser";
      if (result.isError) return `${label} failed: ${summarize(result.content)}`;
      const body = clip(result.content) || "(empty)";
      return `${label}: ${result.content.length} chars (${body})`;
    },

    async handler(input) {
      const action = str(input.action);
      if (action !== "navigate" && action !== "snapshot" && action !== "screenshot" && action !== "close") {
        return {
          content: `browser requires action navigate|snapshot|screenshot|close, got "${action}"`,
          isError: true,
        };
      }

      if (action === "screenshot") {
        return { content: t("tool.browser.screenshot_unavailable"), isError: true };
      }
      if (action === "close") {
        current = null;
        return { content: t("tool.browser.closed") };
      }
      if (action === "snapshot") {
        if (!current) return { content: t("tool.browser.no_page"), isError: true };
        return { content: cap(buildSnapshot(current.url, current.html), current.readTruncated).content };
      }

      // navigate: file:// URLs never leave the SandboxBoundary-style local
      // scope — local files stay behind the read tool, never the network path.
      const url = str(input.url).trim();
      if (url.length === 0) return { content: "browser navigate requires a url", isError: true };
      if (isFileUrl(url)) return { content: t("tool.browser.file_denied"), isError: true };

      let parsed: URL;
      try {
        parsed = new URL(url);
      } catch {
        return { content: `browser navigate rejected invalid URL: ${url}`, isError: true };
      }
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        return { content: t("tool.browser.file_denied"), isError: true };
      }
      requireNetwork(deps.identity, deps.capabilities, parsed.hostname);

      const res = await http.fetch(url);
      let body = await res.text();
      if (!res.ok) {
        return { content: `${res.status} ${res.statusText}: ${body.slice(0, 500)}`, isError: true };
      }
      const readTruncated = body.length > MAX_BROWSER_BYTES;
      if (readTruncated) body = body.slice(0, MAX_BROWSER_BYTES);
      current = { url, html: body, readTruncated };

      const title = extractHtmlTitle(body);
      const summary = title
        ? `navigated ${url} — "${title}" (${body.length} chars)`
        : `navigated ${url} (${body.length} chars)`;
      return { content: cap(summary, readTruncated).content };
    },
  };
  return spec;
}
