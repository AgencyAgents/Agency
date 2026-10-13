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

  // Measured on Windows with Bun 1.4.0: the child of a stopped script ends with it, with no job object of ours.
  // On POSIX a host script can leave a child: the OS sandbox of `codeMode: true` ends them there.
  test.skipIf(process.platform !== "win32")(
    "a cancel ends the processes that a script started, and the model sees each inner call as progress",
    async () => {
      const stop = new AbortController();
      const progress: string[] = [];
      let childPid = 0;
      const alive = (pid: number): boolean => {
        try {
          process.kill(pid, 0);
          return true;
        } catch {
          return false;
        }
      };
      const code =
        `const child = Bun.spawn([${JSON.stringify(process.execPath)}, "-e", "setTimeout(() => {}, 60000)"]);\n` +
        "await tools.echo({ text: String(child.pid) });\nawait new Promise(() => {});";
      const result = await codeTool(() => ({ ...process.env }) as Record<string, string>).handler(
        { code },
        {
          signal: stop.signal,
          onProgress: (message) => progress.push(message),
          callTool: async (_name, input) => {
            childPid = Number(input.text);
            setTimeout(() => stop.abort(), 50);
            return { content: "ok", isError: false };
          },
        },
      );
      expect(result.isError).toBe(true);
      expect(childPid).toBeGreaterThan(0);
      await new Promise((resolve) => setTimeout(resolve, 500));
      const left = alive(childPid);
      if (left) process.kill(childPid);
      expect(left).toBe(false);
      expect(progress).toEqual(["tools.echo"]);
    },
    20_000,
  );

  test("a denied code tool starts no process", async () => {
    const result = await run("return 1;", ["code"]);
    expect(result.content).toContain("permission denied");
  });
});
