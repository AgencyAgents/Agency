import { describe, expect, test } from "bun:test";
import type { HttpClient } from "@agency/net";
import type { ProviderAdapter, ProviderRequest, StreamEvent } from "@agency/providers";
import { Scheduler } from "@agency/providers";
import { runTurn, type ToolSpec } from "../src/loop.ts";
import { CALL_TOOL, deferTools, TOOL_SEARCH } from "../src/tool-search.ts";

const usage = { inputTokens: 1, outputTokens: 1 };
const signal = new AbortController().signal;

function tool(name: string, description: string, origin?: "mcp"): ToolSpec & { origin?: "mcp" } {
  return {
    name,
    description,
    inputSchema: { type: "object", properties: { id: { type: "string" } } },
    riskTier: "safe",
    handler: async (input) => ({ content: `${name} ran with ${JSON.stringify(input)}` }),
    ...(origin ? { origin } : {}),
  };
}

const many = (count: number): ToolSpec[] =>
  Array.from({ length: count }, (_, i) =>
    tool(`tracker_tool_${i}`, `Does thing number ${i} in the tracker.`, "mcp"),
  );

describe("deferTools", () => {
  test("a built-in tool marked deferred waits for a search in every mode", () => {
    const tools = [
      tool("read", "Reads a file."),
      { ...tool("process_kill", "Kills a process."), deferred: true },
    ];
    for (const mode of ["auto", "always", "never"] as const) {
      const sent = deferTools(tools, mode).filter((t) => !t.hidden?.());
      expect(sent.map((t) => t.name)).toEqual(["read", TOOL_SEARCH, CALL_TOOL]);
    }
  });

  test("a small set of MCP tools stays as it is, and so does a set in the never mode", () => {
    const tools = [tool("read", "Reads a file."), ...many(3)];
    expect(deferTools(tools, "auto")).toBe(tools);
    const big = [tool("read", "Reads a file."), ...many(30)];
    expect(deferTools(big, "never")).toBe(big);
  });

  test("a large set of MCP tools is hidden behind tool_search, and other tools are not", async () => {
    const tools = deferTools(
      [tool("read", "Reads a file."), ...many(30), tool("billing_refund", "Refunds an invoice.", "mcp")],
      "auto",
    );
    const visible = tools.filter((t) => !t.hidden?.()).map((t) => t.name);
    expect(visible).toEqual(["read", TOOL_SEARCH, CALL_TOOL]);
    const search = tools.find((t) => t.name === TOOL_SEARCH) as ToolSpec;
    // The names are in the description of the tool: the model can see what there is, with no schema.
    expect(search.description).toContain("billing_refund");
    expect(search.description).toContain("tracker_tool_29");

    const found = await search.handler({ query: "refund an invoice" }, { signal });
    expect(found.content).toContain("billing_refund: Refunds an invoice.");
    // The schema is in the text, and the tool list does not change: the prompt cache of the provider holds.
    expect(found.content).toContain('input schema: {"type":"object","properties":{"id":{"type":"string"}}}');
    expect(tools.filter((t) => !t.hidden?.()).map((t) => t.name)).not.toContain("billing_refund");

    const byName = await search.handler({ query: "tracker_tool_7" }, { signal });
    expect(byName.content).toContain("tracker_tool_7");

    const none = await search.handler({ query: "zzzz" }, { signal });
    expect(none.isError).toBe(true);
  });
});

describe("hidden tools in the loop", () => {
  test("a hidden tool is never in a request; a call by name and a call through call_tool both run", async () => {
    const tools = deferTools([tool("read", "Reads a file."), ...many(12)], "auto");
    const requests: ProviderRequest[] = [];
    const calls = [
      { name: "tracker_tool_3", input: { id: "a" } },
      { name: TOOL_SEARCH, input: { query: "tracker_tool_3" } },
      { name: CALL_TOOL, input: { name: "tracker_tool_3", input: { id: "b" } } },
      { name: CALL_TOOL, input: { name: "tracker_tool_3", input: { id: 5 } } },
      { name: CALL_TOOL, input: { name: "read", input: {} } },
    ];
    const adapter: ProviderAdapter = {
      family: "fake",
      async *stream(request): AsyncIterable<StreamEvent> {
        requests.push(request);
        const call = calls[requests.length - 1];
        if (!call) {
          yield { type: "text_delta", text: "done" };
          yield { type: "message_stop", stopReason: "end_turn", usage };
          return;
        }
        yield { type: "tool_call_start", id: `c${requests.length}`, name: call.name };
        yield {
          type: "tool_call_delta",
          id: `c${requests.length}`,
          inputJsonDelta: JSON.stringify(call.input),
        };
        yield { type: "tool_call_end", id: `c${requests.length}` };
        yield { type: "message_stop", stopReason: "tool_use", usage };
      },
    };
    const http: HttpClient = { fetch: async () => new Response() };
    const result = await runTurn(adapter, new Scheduler({ requestsPerMinute: 1_000_000 }), http, {
      identity: { type: "user" },
      capabilities: { tools: "*", pathScopes: "*", network: "*" },
      systemPrompt: "sys",
      tools,
      model: "m",
      apiKey: "k",
      provider: "fake",
      session: [{ role: "user", content: [{ type: "text", text: "go" }] }],
    });
    const names = (index: number) => (requests[index]?.tools ?? []).map((t) => t.name);
    // The same tool list in each request.
    for (let i = 0; i < requests.length; i++) expect(names(i)).toEqual(["read", TOOL_SEARCH, CALL_TOOL]);
    const text = JSON.stringify(result.messages);
    expect(text).toContain('tracker_tool_3 ran with {\\"id\\":\\"a\\"}');
    // The inner call meets the schema check of the tool, and call_tool is only for the hidden tools.
    expect(text).toContain("id");
    expect(text).not.toContain('ran with {\\"id\\":5}');
    expect(text).toContain("is not a tool of tool_search");
    expect(text).toContain('tracker_tool_3 ran with {\\"id\\":\\"b\\"}');
  });
});
