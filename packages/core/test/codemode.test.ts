import { describe, expect, test } from "bun:test";
import { FULL_CAPABILITIES } from "@agency/guard";
import type { HttpClient } from "@agency/net";
import type { ProviderAdapter, StreamEvent } from "@agency/providers";
import { Scheduler } from "@agency/providers";
import { codeTool } from "../src/codemode.ts";
import { runTurn, type ToolSpec } from "../src/loop.ts";

const noopHttp: HttpClient = { fetch: async () => new Response() };
const usage = { inputTokens: 1, outputTokens: 1 };

function codeThenDone(code: string): ProviderAdapter {
  let call = 0;
  return {
    family: "fake",
    async *stream(): AsyncIterable<StreamEvent> {
      call += 1;
      if (call === 1) {
        yield { type: "tool_call_start", id: "c1", name: "code" };
        yield { type: "tool_call_delta", id: "c1", inputJsonDelta: JSON.stringify({ code }) };
        yield { type: "tool_call_end", id: "c1" };
        yield { type: "message_stop", stopReason: "tool_use", usage };
      } else {
        yield { type: "text_delta", text: "done" };
        yield { type: "message_stop", stopReason: "end_turn", usage };
      }
    },
  };
}

const echo: ToolSpec = {
  name: "echo",
  description: "gives the text back",
  inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
  riskTier: "safe",
  handler: async (input) => ({ content: `echo ${input.text}` }),
};
let removed = 0;
const remove: ToolSpec = {
  name: "remove",
  description: "removes a thing",
  inputSchema: { type: "object", properties: {} },
  riskTier: "dangerous",
  handler: async () => {
    removed += 1;
    return { content: "removed" };
  },
};

async function run(code: string, deny: string[] = []): Promise<{ content: string; isError: boolean }> {
  const result = await runTurn(codeThenDone(code), new Scheduler(), noopHttp, {
    identity: { type: "user" },
    capabilities: FULL_CAPABILITIES,
    systemPrompt: "sys",
    tools: [echo, remove, codeTool(() => ({ ...process.env }) as Record<string, string>)],
    model: "m",
    apiKey: "k",
    session: [],
    toolPolicy: { check: async (request) => (deny.includes(request.tool) ? "deny" : "allow") },
  });
  const block = result.messages[1]?.content[0];
  if (block?.type !== "tool_result") throw new Error("no tool result");
  return { content: block.content, isError: block.isError ?? false };
}

describe("code tool", () => {
  test("a script calls tools in parallel and gives back only what it prints and returns", async () => {
    const result = await run(
      'const [a, b] = await Promise.all([tools.echo({ text: "one" }), tools.echo({ text: "two" })]);\n' +
        "console.log(a.toUpperCase());\nreturn b.length;",
    );
    expect(result).toEqual({ content: "ECHO ONE\nreturn: 8", isError: false });
  });

  test("an inner call meets the permission gate: a denied tool does not run, and the script gets the error", async () => {
    removed = 0;
    const result = await run(
      "try { await tools.remove({}); } catch (error) { console.log('caught: ' + error.message); }",
      ["remove"],
    );
    expect(removed).toBe(0);
    expect(result.content).toContain("caught: permission denied");
    expect(result.isError).toBe(false);
  });

  test("an inner call with a wrong input fails the schema check of the tool", async () => {
    const result = await run("await tools.echo({ text: 5 });");
    expect(result.isError).toBe(true);
    expect(result.content).toContain("text");
  });

  test("a script cannot call the code tool, and an error of the script is an error result", async () => {
    const nested = await run('await tools.code({ code: "return 1" });');
    expect(nested.content).toContain("the code tool cannot call itself");
    expect(nested.isError).toBe(true);
    const broken = await run('console.log("before"); throw new Error("boom");');
    expect(broken.content).toContain("before");
    expect(broken.content).toContain("boom");
    expect(broken.isError).toBe(true);
  });

  test("a denied code tool starts no process", async () => {
    const result = await run("return 1;", ["code"]);
    expect(result.content).toContain("permission denied");
  });
});
