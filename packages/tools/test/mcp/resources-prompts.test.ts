import { describe, expect, test } from "bun:test";
import { FULL_CAPABILITIES } from "@agency/guard";
import { startMcpServers } from "../../src/mcp/manager.ts";
import type { McpTransport } from "../../src/mcp/transport.ts";

const ctx = { signal: new AbortController().signal };

/** A server that answers each method from a table, and records the methods that it got. */
function server(capabilities: Record<string, unknown>, sent: Array<Record<string, unknown>>): McpTransport {
  let handler: ((msg: Record<string, unknown>) => void) | undefined;
  const results: Record<string, (params: Record<string, unknown>) => unknown> = {
    initialize: () => ({ protocolVersion: "2025-03-26", capabilities }),
    "tools/list": () => ({ tools: [{ name: "t" }] }),
    "resources/list": () => ({
      resources: [
        { uri: "docs://guide", name: "Guide", description: "How to deploy." },
        { uri: "img://logo", mimeType: "image/png" },
      ],
    }),
    "resources/read": (params) => ({
      contents:
        params.uri === "img://logo"
          ? [{ uri: params.uri, mimeType: "image/png", blob: "QUJD" }]
          : [{ uri: params.uri, mimeType: "text/plain", text: "Deploy with the blue button." }],
    }),
    "prompts/list": () => ({
      prompts: [
        { name: "review", description: "Reviews an issue.", arguments: [{ name: "id" }, { name: "note" }] },
      ],
    }),
    "prompts/get": (params) => ({
      messages: [
        { role: "user", content: { type: "text", text: `Review this: ${JSON.stringify(params.arguments)}` } },
        { role: "assistant", content: { type: "text", text: "I look at the diff first." } },
      ],
    }),
  };
  return {
    async start() {},
    async send(message) {
      sent.push(message);
      const result = results[String(message.method)];
      if (message.id !== undefined && result) {
        handler?.({
          jsonrpc: "2.0",
          id: message.id,
          result: result((message.params ?? {}) as Record<string, unknown>),
        });
      }
    },
    onMessage(h) {
      handler = h;
    },
    async close() {},
  };
}

const start = (capabilities: Record<string, unknown>, sent: Array<Record<string, unknown>> = []) =>
  startMcpServers({
    servers: { srv: { command: "fake" } },
    capabilities: FULL_CAPABILITIES,
    transportFor: () => server(capabilities, sent),
  });

describe("MCP resources and prompts", () => {
  test("a server that declares none is not asked for them, and adds no tool", async () => {
    const sent: Array<Record<string, unknown>> = [];
    const manager = await start({ tools: {} }, sent);
    expect(manager.tools.map((t) => t.name)).toEqual(["srv_t"]);
    expect(manager.prompts).toEqual([]);
    expect(sent.map((m) => m.method)).toEqual(["initialize", "notifications/initialized", "tools/list"]);
    await manager.dispose();
  });

  test("the resources of a server are listed and read with two tools", async () => {
    const manager = await start({ tools: {}, resources: {} });
    const tool = (name: string) => {
      const found = manager.tools.find((t) => t.name === name);
      if (!found) throw new Error(`no tool ${name}`);
      return found;
    };
    const list = await tool("mcp_list_resources").handler({}, ctx);
    expect(list.content).toBe("srv docs://guide (Guide): How to deploy.\nsrv img://logo");
    const text = await tool("mcp_read_resource").handler({ server: "srv", uri: "docs://guide" }, ctx);
    expect(text.content).toBe("Deploy with the blue button.");
    const image = await tool("mcp_read_resource").handler({ server: "srv", uri: "img://logo" }, ctx);
    expect(image.content).toBe("[image image/png]");
    expect(image.images).toEqual([{ type: "image", mimeType: "image/png", data: "QUJD" }]);
    const unknown = await tool("mcp_read_resource").handler({ server: "other", uri: "x" }, ctx);
    expect(unknown.isError).toBe(true);
    expect(unknown.content).toContain("The servers are: srv");
    await manager.dispose();
  });

  test("a prompt of a server is a slash command, and the words of the command are its arguments", async () => {
    const manager = await start({ prompts: {} });
    expect(manager.prompts.map((p) => `mcp__${p.server}__${p.name}`)).toEqual(["mcp__srv__review"]);
    expect(manager.tools.map((t) => t.name)).toEqual(["srv_t"]);
    const text = await manager.promptText("mcp__srv__review", "42 look at the tests");
    expect(text).toBe('Review this: {"id":"42","note":"look at the tests"}\n\nI look at the diff first.');
    expect(await manager.promptText("mcp__srv__none", "")).toBeUndefined();
    expect(await manager.promptText("review", "")).toBeUndefined();
    await manager.dispose();
  });
});
