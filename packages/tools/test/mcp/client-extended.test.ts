import { describe, expect, test } from "bun:test";
import { McpClient } from "../../src/mcp/client.ts";
import type { McpTransport } from "../../src/mcp/transport.ts";

function fakeTransport(overrides: Partial<McpTransport> = {}): McpTransport {
  return {
    start: async () => {},
    send: async () => {},
    onMessage: () => {},
    close: async () => {},
    ...overrides,
  };
}

describe("McpClient extended", () => {
  test("initialize sends notifications/initialized after initialize", async () => {
    const sent: Record<string, unknown>[] = [];
    let handler: (msg: Record<string, unknown>) => void = () => {};
    const client = new McpClient(
      "srv",
      fakeTransport({
        onMessage: (h) => {
          handler = h;
        },
        send: async (msg) => {
          if (msg.method === "initialize") {
            handler({ jsonrpc: "2.0", id: msg.id, result: {} });
          }
          sent.push(msg);
        },
      }),
    );
    await client.initialize();
    expect(sent.some((m) => m.method === "initialize")).toBe(true);
    expect(sent.some((m) => m.method === "notifications/initialized")).toBe(true);
    await client.close();
  });

  test("callTool honors abort signal cancels pending request", async () => {
    let handler: (msg: Record<string, unknown>) => void = () => {};
    const client = new McpClient(
      "srv",
      fakeTransport({
        onMessage: (h) => {
          handler = h;
        },
        send: async () => {
          // never respond — should be cancelled via signal
        },
      }),
      { requestTimeoutMs: 5000, toolCallTimeoutMs: 5000 },
    );
    const controller = new AbortController();
    const promise = client.callTool("foo", {}, controller.signal);
    controller.abort();
    await expect(promise).rejects.toThrow(/aborted/);
    await client.close();
  });

  test("per-request timeout config is respected", async () => {
    const client = new McpClient(
      "srv",
      fakeTransport({
        send: async () => {
          // never respond
        },
      }),
      { requestTimeoutMs: 50 },
    );
    await expect(client.listTools()).rejects.toThrow(/timed out/);
    await client.close();
  });

  test("list_changed notification fires onListChanged callback", async () => {
    let handler: (msg: Record<string, unknown>) => void = () => {};
    let called = false;
    const client = new McpClient(
      "srv",
      fakeTransport({
        onMessage: (h) => {
          handler = h;
        },
        send: async (msg) => {
          handler({ jsonrpc: "2.0", id: msg.id, result: {} });
        },
      }),
    );
    client.onListChanged(() => {
      called = true;
    });
    // need to capture handler to simulate notification
    // handler is set via onMessage, so trigger with notification
    // we already have handler variable
    await client.initialize();
    handler({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });
    expect(called).toBe(true);
    await client.close();
  });
});
