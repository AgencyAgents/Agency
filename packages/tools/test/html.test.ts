import { describe, expect, test } from "bun:test";
import { decodeEntities, extractHtmlTitle, htmlToMarkdown } from "../src/html.ts";

describe("extractHtmlTitle", () => {
  test("extracts the title", () => {
    expect(extractHtmlTitle("<html><head><title>My Page</title></head></html>")).toBe("My Page");
    expect(extractHtmlTitle("<html><body>no title</body></html>")).toBeUndefined();
    expect(extractHtmlTitle("<title>  </title>")).toBeUndefined();
  });
});

describe("htmlToMarkdown", () => {
  test("converts headings, links, lists and strips scripts and styles", () => {
    const html = [
      "<html><head><script>alert('x')</script><style>body{}</style></head><body>",
      "<h1>Title</h1>",
      "<p>See <a href='https://example.com'>the docs</a>.</p>",
      "<ul><li>one</li><li>two</li></ul>",
      "</body></html>",
    ].join("\n");
    const markdown = htmlToMarkdown(html);
    expect(markdown).toContain("# Title");
    expect(markdown).toContain("[the docs](https://example.com)");
    expect(markdown).toContain("- one");
    expect(markdown).toContain("- two");
    expect(markdown).not.toContain("alert");
    expect(markdown).not.toContain("<h1");
  });

  test("decodes named and numeric entities", () => {
    expect(decodeEntities("A &amp; B &lt;tag&gt; &#65;&#x42;")).toBe("A & B <tag> AB");
  });

  test("never emits three consecutive blank lines", () => {
    expect(htmlToMarkdown("<p>one</p>\n\n\n\n<p>two</p>")).not.toContain("\n\n\n");
  });
});