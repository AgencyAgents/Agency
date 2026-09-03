import { afterEach, describe, expect, test } from "bun:test";
import { createMcpTransport } from "../../src/mcp/transport.ts";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("McpTransport HTTP Streamable", () => {
  test("POST JSON response delivers message", async () => {
    const received: Record<string, unknown>[] = [];
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { ok: true } }), {
        headers: { "content-type": "application/json" },
      }) as unknown as Response;
    const transport = createMcpTransport("http", { url: "https://example.com/mcp" });
    transport.onMessage((msg) => received.push(msg));
    await transport.start();
    await transport.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    expect(received).toEqual([{ jsonrpc: "2.0", id: 1, result: { ok: true } }]);
  });

  test("SSE response stream parses data frames", async () => {
    const received: Record<string, unknown>[] = [];
    const sseBody = 'data: {"jsonrpc":"2.0","id":1,"result":{"tools":[]}}\n\ndata: {"jsonrpc":"2.0","method":"notifications/tools/list_changed"}\n\n';
    globalThis.fetch = async () =>
      new Response(sseBody, {
        headers: { "content-type": "text/event-stream" },
      }) as unknown as Response;
    const transport = createMcpTransport("http", { url: "https://example.com/mcp" });
    transport.onMessage((msg) => received.push(msg));
    await transport.send({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
    expect(received.length).toBe(2);
    expect(received[0]).toEqual({ jsonrpc: "2.0", id: 1, result: { tools: [] } });
    expect(received[1]).toEqual({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });
  });

  test("optional auth headers are sent", async () => {
    let capturedHeaders: Record<string, string> = {};
    globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
      capturedHeaders = (init?.headers ?? {}) as Record<string, string>;
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} }), {
        headers: { "content-type": "application/json" },
      }) as unknown as Response;
    }) as unknown as typeof fetch;
    const transport = createMcpTransport("http", {
      url: "https://example.com/mcp",
      headers: { Authorization: "Bearer token123" },
    });
    transport.onMessage(() => {});
    await transport.send({ jsonrpc: "2.0", id: 1, method: "ping", params: {} });
    expect(capturedHeaders.Authorization).toBe("Bearer token123");
    expect(capturedHeaders.accept).toContain("text/event-stream");
  });

  test("stdio stderr is bounded and exposed via stderrTail", async () => {
    const transport = createMcpTransport("stdio", {
      command: process.execPath,
      args: ["-e", "console.error('boom stderr tail'); setTimeout(()=>{}, 80)"],
    });
    await transport.start();
    await new Promise((r) => setTimeout(r, 200));
    const tail = transport.stderrTail?.() ?? "";
    expect(tail).toContain("boom stderr tail");
    await transport.close();
  });
});
