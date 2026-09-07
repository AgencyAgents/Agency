import { afterEach, describe, expect, test } from "bun:test";
import { McpClient } from "../../src/mcp/client.ts";
import { createMcpTransport } from "../../src/mcp/transport.ts";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("McpTransport HTTP Streamable", () => {
  test("POST JSON response delivers message", async () => {
    const received: Record<string, unknown>[] = [];
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { ok: true } }), {
        headers: { "content-type": "application/json" },
      }) as unknown as Response) as unknown as typeof fetch;
    const transport = createMcpTransport("http", { url: "https://example.com/mcp" });
    transport.onMessage((msg) => received.push(msg));
    await transport.start();
    await transport.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    expect(received).toEqual([{ jsonrpc: "2.0", id: 1, result: { ok: true } }]);
  });

  test("SSE response stream parses data frames", async () => {
    const received: Record<string, unknown>[] = [];
    const sseBody =
      'data: {"jsonrpc":"2.0","id":1,"result":{"tools":[]}}\n\ndata: {"jsonrpc":"2.0","method":"notifications/tools/list_changed"}\n\n';
    globalThis.fetch = (async () =>
      new Response(sseBody, {
        headers: { "content-type": "text/event-stream" },
      }) as unknown as Response) as unknown as typeof fetch;
    const transport = createMcpTransport("http", { url: "https://example.com/mcp" });
    transport.onMessage((msg) => received.push(msg));
    await transport.send({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
    expect(received.length).toBe(2);
    expect(received[0]).toEqual({ jsonrpc: "2.0", id: 1, result: { tools: [] } });
    expect(received[1]).toEqual({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });
  });

  test("optional auth headers are sent", async () => {
    let capturedHeaders: Record<string, string> = {};
    globalThis.fetch = (async (_url: string | URL, init?: RequestInit) => {
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

  test("persistent GET stream receives server notifications outside request/response", async () => {
    const received: Record<string, unknown>[] = [];
    let getCalled = false;

    globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
      if (init?.method === "GET" || (!init?.method && typeof url === "string")) {
        getCalled = true;
        // Return an SSE stream that delivers a notification then hangs
        const encoder = new TextEncoder();
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(
              encoder.encode('data: {"jsonrpc":"2.0","method":"notifications/tools/list_changed"}\n\n'),
            );
            // Don't close — simulate a persistent connection
          },
        });
        return new Response(body, {
          headers: { "content-type": "text/event-stream" },
        }) as unknown as Response;
      }
      // POST returns a simple JSON response
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { ok: true } }), {
        headers: { "content-type": "application/json" },
      }) as unknown as Response;
    }) as unknown as typeof fetch;

    const transport = createMcpTransport("http", { url: "https://example.com/mcp" });
    transport.onMessage((msg) => received.push(msg));
    await transport.start();
    // Give the GET stream a moment to deliver its notification
    await new Promise((r) => setTimeout(r, 50));
    expect(getCalled).toBe(true);
    expect(received.length).toBeGreaterThanOrEqual(1);
    expect(received[0]).toEqual({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });

    // POST still works for request/response
    await transport.send({ jsonrpc: "2.0", id: 1, method: "ping", params: {} });
    expect(received.length).toBeGreaterThanOrEqual(2);
    expect(received[1]).toEqual({ jsonrpc: "2.0", id: 1, result: { ok: true } });

    await transport.close();
  });

  test("stdio stderr is bounded and exposed via stderrTail", async () => {
    const transport = createMcpTransport("stdio", {
      command: process.execPath,
      args: ["-e", "console.error('boom stderr tail'); setTimeout(()=>{}, 80)"],
    });
    await transport.start();
    const deadline = Date.now() + 2_000;
    let tail = "";
    while (Date.now() < deadline) {
      tail = transport.stderrTail?.() ?? "";
      if (tail.includes("boom stderr tail")) break;
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(tail).toContain("boom stderr tail");
    await transport.close();
  });

  test("per-server timeoutMs aborts a hanging POST", async () => {
    globalThis.fetch = ((_url: string | URL, _init?: RequestInit) =>
      new Promise(() => {})) as unknown as typeof fetch;
    const transport = createMcpTransport("http", { url: "https://example.com/mcp", timeoutMs: 20 });
    transport.onMessage(() => {});
    await expect(transport.send({ jsonrpc: "2.0", id: 1, method: "ping", params: {} })).rejects.toThrow(
      /timed out after 20ms/,
    );
    await transport.close();
  });

  test("per-server headers merge without clobbering content-type/accept", async () => {
    let captured: Record<string, string> = {};
    globalThis.fetch = (async (_url: string | URL, init?: RequestInit) => {
      captured = (init?.headers ?? {}) as Record<string, string>;
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} }), {
        headers: { "content-type": "application/json" },
      }) as unknown as Response;
    }) as unknown as typeof fetch;
    const transport = createMcpTransport("http", {
      url: "https://example.com/mcp",
      headers: { Authorization: "Bearer abc", "X-Custom": "yes" },
    });
    transport.onMessage(() => {});
    await transport.send({ jsonrpc: "2.0", id: 1, method: "ping", params: {} });
    expect(captured.Authorization).toBe("Bearer abc");
    expect(captured["X-Custom"]).toBe("yes");
    expect(captured["content-type"]).toBe("application/json");
    expect(captured.accept).toContain("application/json");
  });

  test("SSE multi-message with CRLF and split chunks all parse", async () => {
    const received: Record<string, unknown>[] = [];
    const encoder = new TextEncoder();
    const chunks = [
      'data: {"jsonrpc":"2.0","id":1,"result":{"a":1}}\r\n\r\nda',
      'ta: {"jsonrpc":"2.0","id":2,"result":{"b":2}}\n\n: comment heartbeat\n\ndata: {"jsonrpc":"2.0","method":"notifications/x"}\n\n',
    ];
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const c of chunks) controller.enqueue(encoder.encode(c));
        controller.close();
      },
    });
    globalThis.fetch = (async (_url: string | URL, init?: RequestInit) => {
      if ((init?.method ?? "GET") === "GET") {
        return new Response(
          new ReadableStream<Uint8Array>({
            start(c) {
              c.close();
            },
          }),
          {
            headers: { "content-type": "text/event-stream" },
          },
        ) as unknown as Response;
      }
      return new Response(body, {
        headers: { "content-type": "text/event-stream" },
      }) as unknown as Response;
    }) as unknown as typeof fetch;
    const transport = createMcpTransport("http", { url: "https://example.com/mcp" });
    transport.onMessage((msg) => received.push(msg));
    await transport.send({ jsonrpc: "2.0", id: 1, method: "ping", params: {} });
    expect(received.length).toBe(3);
    expect(received[0]).toEqual({ jsonrpc: "2.0", id: 1, result: { a: 1 } });
    expect(received[1]).toEqual({ jsonrpc: "2.0", id: 2, result: { b: 2 } });
    expect(received[2]).toEqual({ jsonrpc: "2.0", method: "notifications/x" });
    await transport.close();
  });

  test("stdio stderr ring stays within 8KB bound", async () => {
    const transport = createMcpTransport("stdio", {
      command: process.execPath,
      args: ["-e", "for(let i=0;i<400;i++) console.error('x'.repeat(100)); setTimeout(()=>{}, 150)"],
    });
    await transport.start();
    await new Promise((r) => setTimeout(r, 400));
    const tail = transport.stderrTail?.() ?? "";
    expect(tail.length).toBeLessThanOrEqual(8192);
    expect(tail.length).toBeGreaterThan(0);
    await transport.close();
  });

  test("http transport exposes empty stderrTail for parity", async () => {
    const transport = createMcpTransport("http", { url: "https://example.com/mcp" });
    expect(transport.stderrTail?.()).toBe("");
    await transport.close();
  });

  test("onClose fails all pending client requests", async () => {
    let closeHandler: (() => void) | undefined;
    let messageHandler: ((msg: Record<string, unknown>) => void) | undefined;
    const fakeTransport = {
      start: async () => {},
      send: async () => {},
      onMessage(h: (msg: Record<string, unknown>) => void) {
        messageHandler = h;
      },
      onClose(h: () => void) {
        closeHandler = h;
      },
      close: async () => {
        closeHandler?.();
      },
    };
    expect(messageHandler).toBeUndefined();
    const client = new McpClient("fake", fakeTransport);
    const pending = client.listTools();
    await fakeTransport.close();
    await expect(pending).rejects.toThrow(/transport closed/);
  });
});
