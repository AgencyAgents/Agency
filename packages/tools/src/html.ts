const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  mdash: "—",
  ndash: "–",
  hellip: "…",
  copy: "©",
  reg: "®",
  trade: "™",
};

export function decodeEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, body: string) => {
    if (body.startsWith("#x") || body.startsWith("#X")) {
      const code = Number.parseInt(body.slice(2), 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    if (body.startsWith("#")) {
      const code = Number.parseInt(body.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    return NAMED_ENTITIES[body] ?? match;
  });
}

export function extractHtmlTitle(html: string): string | undefined {
  const match = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  const raw = match?.[1];
  if (raw === undefined) return undefined;
  const title = decodeEntities(raw).replace(/\s+/g, " ").trim();
  return title.length > 0 ? title : undefined;
}

function inline(text: string): string {
  return decodeEntities(text.replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim();
}

/**
 * Minimal HTML→markdown-ish conversion for fetch results: enough structure
 * (headings, lists, links, code blocks, paragraphs) that a model reads a page
 * instead of a tag soup. Deliberately regex-based — no dependency budget for
 * a real parser, and the output only needs to be legible, not round-trippable.
 */
export function htmlToMarkdown(html: string): string {
  let s = html;
  s = s.replace(/<!--[\s\S]*?-->/g, "");
  s = s.replace(/<(script|style|noscript|svg|template|head)\b[\s\S]*?<\/\1>/gi, "");
  s = s.replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi, (_m, level: string, inner: string) => {
    const hashes = "#".repeat(Number.parseInt(level, 10));
    return `\n\n${hashes} ${inline(inner)}\n\n`;
  });
  s = s.replace(
    /<a\b[^>]*href=["']([^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi,
    (_m, href: string, inner: string) => `[${inline(inner)}](${href})`,
  );
  s = s.replace(/<pre\b[^>]*>([\s\S]*?)<\/pre>/gi, (_m, inner: string) => `\n\`\`\`\n${decodeEntities(inner.replace(/<[^>]+>/g, ""))}\n\`\`\`\n`);
  s = s.replace(/<li\b[^>]*>([\s\S]*?)<\/li>/gi, (_m, inner: string) => `\n- ${inline(inner)}`);
  s = s.replace(/<br\s*\/?>/gi, "\n");
  s = s.replace(/<\/(p|div|section|article|header|footer|main|blockquote|tr|table|ul|ol)>/gi, "\n\n");
  s = s.replace(/<[^>]+>/g, "");
  s = decodeEntities(s);
  s = s.replace(/[ \t]+\n/g, "\n");
  s = s.replace(/\n{3,}/g, "\n\n");
  return s.trim();
}
