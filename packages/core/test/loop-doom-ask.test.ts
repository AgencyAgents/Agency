import { describe, expect, test } from "bun:test";
import type { HttpClient } from "@agency/net";
import { Scheduler } from "@agency/providers";
import { doomApprovalRequest, runTurn } from "../src/loop.ts";

const noopHttp: HttpClient = { fetch: async () => new Response() };
const user = { type: "user" } as const;
const caps = { tools: "*", pathScopes: "*", network: "*" } as never;

// Repeats the identical tool+input every turn so the 3x doom threshold trips.
function repeatingAdapter(repeats: number) {
  let calls = 0;
  return {
    family: "fake",
    async *stream(): AsyncIterable<never> {
      calls += 1;
      if (calls > repeats) {
        yield {
          type: "message_stop",
          stopReason: "end_turn",
          usage: { inputTokens: 1, outputTokens: 1 },
        } as never;
        return;
      }
      yield { type: "tool_call_start", id: `c${calls}`, name: "read" } as never;
      yield {
        type: "tool_call_delta",
        id: `c${calls}`,
        inputJsonDelta: JSON.stringify({ path: "same" }),
      } as never;
      yield { type: "tool_call_end", id: `c${calls}` } as never;
      yield {
        type: "message_stop",
        stopReason: "tool_use",
        usage: { inputTokens: 1, outputTokens: 1 },
      } as never;
    },
  } as never;
}

const readTool = {
  name: "read",
  description: "r",
  inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
  handler: async () => ({ content: "ok" }),
  riskTier: "safe",
};

function baseOptions(extra: Record<string, unknown> = {}) {
  return {
    identity: user,
    capabilities: caps,
    systemPrompt: "sys",
    tools: [readTool],
    model: "m",
    apiKey: "k",
    session: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    maxToolIterations: 10,
    doomLoopDetection: true,
    ...extra,
  } as unknown as Parameters<typeof runTurn>[3];
}

describe("doom loop ask routing", () => {
  test("doom threshold builds an approval request instead of spinning", () => {
    const req = doomApprovalRequest("read", 3);
    expect(req.tool).toBe("doom-loop");
    expect(req.title).toContain("read");
    expect(req.title).toContain("3");
  });

  test("approving the doom ask continues the turn instead of throwing", async () => {
    const asks: unknown[] = [];
    const result = await runTurn(
      repeatingAdapter(5),
      new Scheduler(),
      noopHttp,
      baseOptions({
        requestApproval: (async (req: unknown) => {
          asks.push(req);
          return "once";
        }) as never,
      }),
    );
    expect(asks).toHaveLength(1);
    expect((asks[0] as { tool: string }).tool).toBe("doom-loop");
    expect(result.stopReason).toBe("end_turn");
  });

  test("rejecting the doom ask halts with the doom loop error", async () => {
    await expect(
      runTurn(
        repeatingAdapter(5),
        new Scheduler(),
        noopHttp,
        baseOptions({
          requestApproval: (async () => "reject") as never,
        }),
      ),
    ).rejects.toThrow(/doom loop/);
  });

  test("no approval surface fails closed with the doom loop error", async () => {
    await expect(runTurn(repeatingAdapter(5), new Scheduler(), noopHttp, baseOptions())).rejects.toThrow(
      /doom loop/,
    );
  });
});
