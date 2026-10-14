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

  test("the handshake has the fields that the specification makes mandatory, and keeps the server capabilities", async () => {
    let deliver: (msg: Record<string, unknown>) => void = () => {};
    const client = new McpClient(
      "strict",
      fakeTransport({
        onMessage: (handler) => {
          deliver = handler;
        },
        send: async (msg) => {
          if (msg.id === undefined) return;
          const p = (msg.params ?? {}) as Record<string, unknown>;
          // A server that validates the request refuses one without these three fields.
          const valid =
            typeof p.protocolVersion === "string" &&
            typeof p.capabilities === "object" &&
            p.capabilities !== null &&
            typeof p.clientInfo === "object";
          deliver(
            valid
              ? {
                  jsonrpc: "2.0",
                  id: msg.id,
                  result: { protocolVersion: p.protocolVersion, capabilities: { resources: {} } },
                }
              : { jsonrpc: "2.0", id: msg.id, error: { code: -32602, message: "Invalid params" } },
          );
        },
      }),
    );
    await client.initialize();
    expect(client.serverCapabilities).toEqual({ resources: {} });
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

  test("a list that the server gives in pages is read to its end, and a server that repeats a cursor does not hang", async () => {
    let deliver: (msg: Record<string, unknown>) => void = () => {};
    const pages: Record<string, { items: string[]; next?: string }> = {
      "": { items: ["a", "b"], next: "p2" },
      p2: { items: ["c"], next: "p3" },
      p3: { items: ["d"] },
      // A broken server: the cursor points at itself.
      loop: { items: ["x"], next: "loop" },
    };
    let start = "";
    const client = new McpClient(
      "paged",
      fakeTransport({
        onMessage: (handler) => {
          deliver = handler;
        },
        send: async (msg) => {
          const key = (msg.method as string).split("/")[0] as string;
          const cursor = ((msg.params ?? {}) as { cursor?: string }).cursor ?? start;
          const page = pages[cursor] ?? { items: [] };
          const items = page.items.map((name) => ({ name, uri: name }));
          const result = { [key]: items, ...(page.next ? { nextCursor: page.next } : {}) };
          deliver({ jsonrpc: "2.0", id: msg.id, result });
        },
      }),
    );
    expect((await client.listTools()).map((t) => t.name)).toEqual(["a", "b", "c", "d"]);
    expect((await client.listResources()).map((r) => r.uri)).toEqual(["a", "b", "c", "d"]);
    expect((await client.listPrompts()).map((p) => p.name)).toEqual(["a", "b", "c", "d"]);
    start = "loop";
    // The second page gives the same cursor again: the read ends there.
    expect((await client.listTools()).map((t) => t.name)).toEqual(["x", "x"]);
    await client.close();
  });
});
