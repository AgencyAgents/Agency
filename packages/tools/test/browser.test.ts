import { describe, expect, test } from "bun:test";
import { FULL_CAPABILITIES, SandboxBoundary } from "@agency/guard";
import type { HttpClient } from "@agency/net";
import { createBrowserTool } from "../src/builtins/browser.ts";
import type { ToolDeps } from "../src/contract.ts";

function deps(capabilities = FULL_CAPABILITIES): ToolDeps {
  return { identity: { type: "user" }, capabilities, sandbox: new SandboxBoundary(".") };
}

const signal = new AbortController().signal;

const PAGE = `<!doctype html><html><head><title>Example Page</title></head><body>
<h1>Hello</h1><h2>World</h2>
<p>Some text with <a href="https://example.com/more">more</a>.</p>
</body></html>`;

function httpWith(body: string, status = 200): HttpClient {
  return { fetch: async () => new Response(body, { status }) };
}

describe("createBrowserTool", () => {
  test("navigate stores the page and reports its title", async () => {
    const tool = createBrowserTool(deps(), httpWith(PAGE));
    const result = await tool.handler({ action: "navigate", url: "https://example.com" }, { signal });
    expect(result.isError).toBeFalsy();
    expect(result.content).toContain("Example Page");
  });

  test("snapshot returns title, headings, and links", async () => {
    const tool = createBrowserTool(deps(), httpWith(PAGE));
    await tool.handler({ action: "navigate", url: "https://example.com" }, { signal });
    const result = await tool.handler({ action: "snapshot" }, { signal });
    expect(result.isError).toBeFalsy();
    expect(result.content).toContain("Title: Example Page");
    expect(result.content).toContain("[h1] Hello");
    expect(result.content).toContain("[more](https://example.com/more)");
  });

  test("snapshot with no page is an error", async () => {
    const tool = createBrowserTool(deps(), httpWith(PAGE));
    const result = await tool.handler({ action: "snapshot" }, { signal });
    expect(result.isError).toBe(true);
    expect(result.content).toContain("no open page");
  });

  test("screenshot returns an informative denial", async () => {
    const tool = createBrowserTool(deps(), httpWith(PAGE));
    const result = await tool.handler({ action: "screenshot" }, { signal });
    expect(result.isError).toBe(true);
    expect(result.content).toContain("chromium");
  });

  test("close discards the page", async () => {
    const tool = createBrowserTool(deps(), httpWith(PAGE));
    await tool.handler({ action: "navigate", url: "https://example.com" }, { signal });
    const closed = await tool.handler({ action: "close" }, { signal });
    expect(closed.isError).toBeFalsy();
    const after = await tool.handler({ action: "snapshot" }, { signal });
    expect(after.isError).toBe(true);
  });

  test("file:// URLs are denied", async () => {
    const tool = createBrowserTool(deps(), httpWith(PAGE));
    const result = await tool.handler({ action: "navigate", url: "file:///etc/passwd" }, { signal });
    expect(result.isError).toBe(true);
    expect(result.content).toContain("file://");
  });

  test("non-2xx navigate is an error with status", async () => {
    const http: HttpClient = {
      fetch: async () => new Response("gone", { status: 404, statusText: "Not Found" }),
    };
    const tool = createBrowserTool(deps(), http);
    const result = await tool.handler({ action: "navigate", url: "https://example.com/missing" }, { signal });
    expect(result.isError).toBe(true);
    expect(result.content).toContain("404");
  });

  test("denies a host outside network capabilities", async () => {
    const tool = createBrowserTool(
      deps({ ...FULL_CAPABILITIES, network: ["allowed.example.com"] }),
      httpWith(PAGE),
    );
    await expect(
      tool.handler({ action: "navigate", url: "https://evil.example.com" }, { signal }),
    ).rejects.toThrow();
  });
});
