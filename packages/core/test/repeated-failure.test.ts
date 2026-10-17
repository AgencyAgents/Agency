import { expect, test } from "bun:test";
import { FULL_CAPABILITIES } from "@agency/guard";
import type { HttpClient } from "@agency/net";
import type { ProviderAdapter, ProviderRequest, StreamEvent } from "@agency/providers";
import { Scheduler } from "@agency/providers";
import { runTurn } from "../src/loop.ts";

const noopHttp: HttpClient = { fetch: async () => new Response() };
const usage = { inputTokens: 1, outputTokens: 1 };

/** Sends `inputs` as one call each, then ends; records the requests. */
function caller(inputs: Record<string, unknown>[], seen: ProviderRequest[]): ProviderAdapter {
  return {
    family: "fake",
    async *stream(request): AsyncIterable<StreamEvent> {
      seen.push(request);
      const input = inputs[seen.length - 1];
      if (input === undefined) {
        yield { type: "text_delta", text: "stuck" };
        yield { type: "message_stop", stopReason: "end_turn", usage };
        return;
      }
      yield { type: "tool_call_start", id: `c${seen.length}`, name: "deploy" };
      yield { type: "tool_call_delta", id: `c${seen.length}`, inputJsonDelta: JSON.stringify(input) };
      yield { type: "tool_call_end", id: `c${seen.length}` };
      yield { type: "message_stop", stopReason: "tool_use", usage };
    },
  };
}

const results = (requests: ProviderRequest[]) =>
  requests.flatMap((r) => {
    const block = r.messages.at(-1)?.content.at(-1);
    return block?.type === "tool_result" ? [block.content] : [];
  });

async function run(inputs: Record<string, unknown>[]) {
  const seen: ProviderRequest[] = [];
  await runTurn(caller(inputs, seen), new Scheduler({ maxAttempts: 1 }), noopHttp, {
    identity: { type: "user" },
    capabilities: FULL_CAPABILITIES,
    systemPrompt: "sys",
    model: "m",
    apiKey: "k",
    session: [{ role: "user", content: [{ type: "text", text: "deploy it" }] }],
    tools: [
      {
        name: "deploy",
        description: "deploy",
        inputSchema: { type: "object", properties: {} },
        handler: async (input) => ({ content: `no target named ${String(input.to)}`, isError: true }),
      },
    ],
  });
  return results(seen);
}

test("the third same failure of the same call tells the model to change course", async () => {
  const same = await run([{ to: "prod" }, { to: "prod" }, { to: "prod" }]);
  expect(same).toHaveLength(3);
  expect(same[1]).not.toContain("[harness:");
  expect(same[2]).toContain("deploy failed 3 times with the same input and the same error");
});

test("a call that changes its input is not a repeat", async () => {
  const changed = await run([{ to: "prod" }, { to: "prd" }, { to: "production" }]);
  expect(changed.some((r) => r.includes("[harness:"))).toBe(false);
});
