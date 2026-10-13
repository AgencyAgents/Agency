import { describe, expect, test } from "bun:test";
import type { HttpClient } from "@agency/net";
import type { ProviderAdapter, ProviderRequest, StreamEvent } from "@agency/providers";
import { Scheduler } from "@agency/providers";
import { runTurn, type ToolSpec } from "../src/loop.ts";
import { deferTools, TOOL_SEARCH } from "../src/tool-search.ts";

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
  test("a small set of MCP tools stays as it is, and so does a set in the never mode", () => {
    const tools = [tool("read", "Reads a file."), ...many(3)];
    expect(deferTools(tools, "auto", new Set())).toBe(tools);
    const big = [tool("read", "Reads a file."), ...many(30)];
    expect(deferTools(big, "never", new Set())).toBe(big);
  });

  test("a large set of MCP tools is hidden behind tool_search, and other tools are not", async () => {
    const loaded = new Set<string>();
    const tools = deferTools(
      [tool("read", "Reads a file."), ...many(30), tool("billing_refund", "Refunds an invoice.", "mcp")],
      "auto",
      loaded,
    );
    const visible = tools.filter((t) => !t.hidden?.()).map((t) => t.name);
    expect(visible).toEqual(["read", TOOL_SEARCH]);
    const search = tools.find((t) => t.name === TOOL_SEARCH) as ToolSpec;
    // The names are in the description of the tool: the model can see what there is, with no schema.
    expect(search.description).toContain("billing_refund");
    expect(search.description).toContain("tracker_tool_29");

    const found = await search.handler({ query: "refund an invoice" }, { signal });
    expect(found.content).toContain("billing_refund: Refunds an invoice.");
    expect([...loaded]).toContain("billing_refund");
    expect(tools.filter((t) => !t.hidden?.()).map((t) => t.name)).toContain("billing_refund");

    const byName = await search.handler({ query: "tracker_tool_7" }, { signal });
    expect(byName.content).toContain("tracker_tool_7");
    expect(loaded.has("tracker_tool_7")).toBe(true);

    const none = await search.handler({ query: "zzzz" }, { signal });
    expect(none.isError).toBe(true);
  });
});

describe("hidden tools in the loop", () => {
  test("a hidden tool is not in the request, a call of it is refused, and it is in the request after a load", async () => {
    const loaded = new Set<string>();
    const tools = deferTools([tool("read", "Reads a file."), ...many(12)], "auto", loaded);
    const requests: ProviderRequest[] = [];
    const calls = [
      { name: "tracker_tool_3", input: { id: "a" } },
      { name: TOOL_SEARCH, input: { query: "tracker_tool_3" } },
      { name: "tracker_tool_3", input: { id: "b" } },
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
    expect(names(0)).toEqual(["read", TOOL_SEARCH]);
    const text = JSON.stringify(result.messages);
    expect(text).toContain("is not loaded");
    expect(names(2)).toContain("tracker_tool_3");
    expect(text).toContain('tracker_tool_3 ran with {\\"id\\":\\"b\\"}');
    expect(text).not.toContain('ran with {\\"id\\":\\"a\\"}');
  });
});
