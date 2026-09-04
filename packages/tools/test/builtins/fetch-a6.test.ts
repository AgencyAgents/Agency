import { describe, expect, test } from "bun:test";
import { FULL_CAPABILITIES, SandboxBoundary } from "@agency/guard";
import type { HttpClient } from "@agency/net";
import { createFetchTool } from "../../src/builtins/fetch.ts";
import type { ToolDeps } from "../../src/contract.ts";

const deps: ToolDeps = {
  identity: { type: "user" },
  capabilities: FULL_CAPABILITIES,
  sandbox: new SandboxBoundary("."),
};
const signal = new AbortController().signal;

describe("fetch: content-type handling (A6)", () => {
  test("converts text/html to markdown with the title", async () => {
    const http: HttpClient = {
      fetch: async () =>
        new Response("<html><head><title>T</title></head><body><p>hello world</p></body></html>", {
          status: 200,
          headers: { "content-type": "text/html; charset=utf-8" },
        }),
    };
    const tool = createFetchTool(deps, http);
    const result = await tool.handler({ url: "https://example.com" }, { signal });

    expect(result.content).toContain("# T");
    expect(result.content).toContain("hello world");
    expect(result.content).not.toContain("<p>");
  });

  test("keeps non-HTML bodies raw", async () => {
    const http: HttpClient = { fetch: async () => new Response("plain body", { status: 200 }) };
    const tool = createFetchTool(deps, http);
    const result = await tool.handler({ url: "https://example.com" }, { signal });
    expect(result.content).toBe("plain body");
  });

  test("falls back to the raw body when conversion yields nothing", async () => {
    const http: HttpClient = {
      fetch: async () =>
        new Response("<html><body>   </body></html>", {
          status: 200,
          headers: { "content-type": "text/html" },
        }),
    };
    const tool = createFetchTool(deps, http);
    const result = await tool.handler({ url: "https://example.com" }, { signal });
    expect(result.content).toContain("<html>");
  });
});
