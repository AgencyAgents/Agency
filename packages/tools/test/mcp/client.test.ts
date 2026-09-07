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

describe("McpClient", () => {
  test("a failed transport.send rejects the request immediately with the real error", async () => {
    const client = new McpClient(
      "broken",
      fakeTransport({
        send: async () => {
          throw new Error("transport not started");
        },
      }),
    );
    await expect(client.initialize()).rejects.toThrow("transport not started");
    await client.close();
  });

  test("a response resolves the waiting request", async () => {
    let deliver: (msg: Record<string, unknown>) => void = () => {};
    const client = new McpClient(
      "echo",
      fakeTransport({
        onMessage: (handler) => {
          deliver = handler;
        },
        send: async (msg) => {
          deliver({ jsonrpc: "2.0", id: msg.id, result: { tools: [{ name: "t" }] } });
        },
      }),
    );
    expect(await client.listTools()).toEqual([{ name: "t" }]);
    await client.close();
  });

  test("an error response rejects with the server's message", async () => {
    let deliver: (msg: Record<string, unknown>) => void = () => {};
    const client = new McpClient(
      "err",
      fakeTransport({
        onMessage: (handler) => {
          deliver = handler;
        },
        send: async (msg) => {
          deliver({
            jsonrpc: "2.0",
            id: msg.id,
            error: { code: -32601, message: "no such method" },
          });
        },
      }),
    );
    await expect(client.initialize()).rejects.toThrow("no such method");
    await client.close();
  });

  test("a send failure after the response settled is caught, not an unhandled rejection", async () => {
    let deliver: (msg: Record<string, unknown>) => void = () => {};
    let failSend: (error: Error) => void = () => {};
    const client = new McpClient(
      "late",
      fakeTransport({
        onMessage: (handler) => {
          deliver = handler;
        },
        send: (msg) => {
          deliver({ jsonrpc: "2.0", id: msg.id, result: {} });
          return new Promise<void>((_resolve, reject) => {
            failSend = reject;
          });
        },
      }),
    );
    await client.initialize();
    failSend(new Error("write after close"));
    await new Promise((resolve) => setTimeout(resolve, 10));
    await client.close();
  });
});
