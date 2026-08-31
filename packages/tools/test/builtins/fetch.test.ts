import { describe, expect, test } from "bun:test";
import { FULL_CAPABILITIES, SandboxBoundary } from "@agency/guard";
import type { HttpClient } from "@agency/net";
import { createFetchTool } from "../../src/builtins/fetch.ts";
import type { ToolDeps } from "../../src/contract.ts";

function deps(capabilities = FULL_CAPABILITIES): ToolDeps {
  return { identity: { type: "user" }, capabilities, sandbox: new SandboxBoundary(".") };
}

const signal = new AbortController().signal;

describe("createFetchTool", () => {
  test("returns the response body as text", async () => {
    const http: HttpClient = { fetch: async () => new Response("hello world", { status: 200 }) };
    const tool = createFetchTool(deps(), http);

    const result = await tool.handler({ url: "https://example.com" }, { signal });

    expect(result.content).toBe("hello world");
    expect(result.isError).toBeFalsy();
  });

  test("reports a non-2xx response as an error with status and body", async () => {
    const http: HttpClient = {
      fetch: async () => new Response("not found", { status: 404, statusText: "Not Found" }),
    };
    const tool = createFetchTool(deps(), http);

    const result = await tool.handler({ url: "https://example.com/missing" }, { signal });

    expect(result.isError).toBe(true);
    expect(result.content).toContain("404");
  });

  test("truncates a very large response body", async () => {
    const http: HttpClient = { fetch: async () => new Response("x".repeat(60_000), { status: 200 }) };
    const tool = createFetchTool(deps(), http);

    const result = await tool.handler({ url: "https://example.com" }, { signal });

    expect(result.content).toContain("[truncated");
    expect(result.content.length).toBeLessThan(51_000);
  });

  test("denies a host not covered by network capabilities", async () => {
    const http: HttpClient = { fetch: async () => new Response("should not be reached") };
    const scoped = deps({ ...FULL_CAPABILITIES, network: ["allowed.example.com"] });
    const tool = createFetchTool(scoped, http);

    await expect(tool.handler({ url: "https://evil.example.com" }, { signal })).rejects.toThrow();
  });
});
