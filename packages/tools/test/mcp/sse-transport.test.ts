import { expect, test } from "bun:test";
import { createMcpTransport } from "../../src/mcp/transport.ts";

/** A server with the older SSE transport of MCP: GET /sse names the endpoint, and replies go out on that stream. */
function sseServer(endpoint: string) {
  let push: ((text: string) => void) | undefined;
  const posts: unknown[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (req.method === "GET") {
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            push = (text) => controller.enqueue(new TextEncoder().encode(text));
            push(`: hello\n\nevent: endpoint\ndata: ${endpoint}\n\n`);
          },
        });
        return new Response(stream, { headers: { "content-type": "text/event-stream" } });
      }
      if (req.method === "POST" && url.pathname === "/messages") {
        const message = (await req.json()) as { id: number; method: string };
        posts.push({ ...message, session: url.searchParams.get("sessionId") });
        const reply = { jsonrpc: "2.0", id: message.id, result: { echo: message.method } };
        push?.(`event: message\ndata: ${JSON.stringify(reply)}\n\n`);
        return new Response("Accepted", { status: 202 });
      }
      return new Response("not found", { status: 404 });
    },
  });
  return { server, posts };
}

test("an MCP server over SSE: its endpoint event names where messages go, and the replies come on the stream", async () => {
  const { server, posts } = sseServer("/messages?sessionId=abc");
  try {
    // A url that ends in /sse needs no `type`.
    const transport = createMcpTransport("legacy", { url: `http://127.0.0.1:${server.port}/sse` });
    const received: Record<string, unknown>[] = [];
    const replied = new Promise<void>((resolve) =>
      transport.onMessage((message) => {
        received.push(message);
        resolve();
      }),
    );
    await transport.start();
    await transport.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    await replied;
    expect(posts).toEqual([{ jsonrpc: "2.0", id: 1, method: "initialize", params: {}, session: "abc" }]);
    expect(received).toEqual([{ jsonrpc: "2.0", id: 1, result: { echo: "initialize" } }]);
    await transport.close();
  } finally {
    server.stop(true);
  }
});

test("an SSE endpoint of another origin is refused, so the headers of the config stay with the server", async () => {
  const { server, posts } = sseServer("http://other.invalid/messages");
  try {
    const transport = createMcpTransport("legacy", {
      type: "sse",
      url: `http://127.0.0.1:${server.port}/events`,
      headers: { authorization: "Bearer secret" },
      timeoutMs: 2000,
    });
    transport.onMessage(() => {});
    await transport.start();
    await expect(transport.send({ jsonrpc: "2.0", id: 1, method: "initialize" })).rejects.toThrow(
      "another origin",
    );
    expect(posts).toEqual([]);
    await transport.close();
  } finally {
    server.stop(true);
  }
});
