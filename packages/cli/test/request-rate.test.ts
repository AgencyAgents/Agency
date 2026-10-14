import { afterAll, afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolSpec } from "@agency/core";
import type { HttpClient } from "@agency/net";
import type { ProviderAdapter, StreamEvent } from "@agency/providers";
import { connectToDaemon, type DaemonClient } from "@agency/rpc";
import { type AgentDaemon, createAgentDaemon } from "../src/daemon.ts";

const prevKey = process.env.AGENCY_OPENROUTER_API_KEY;
process.env.AGENCY_OPENROUTER_API_KEY = "test-key-rate";
afterAll(() => {
  if (prevKey === undefined) delete process.env.AGENCY_OPENROUTER_API_KEY;
  else process.env.AGENCY_OPENROUTER_API_KEY = prevKey;
});

const dirs: string[] = [];
let daemon: AgentDaemon | undefined;
let client: DaemonClient | undefined;
afterEach(async () => {
  await client?.close();
  await daemon?.stop();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const tmp = (name: string): string => {
  const dir = mkdtempSync(join(tmpdir(), `agency-rate-${name}-`));
  dirs.push(dir);
  return dir;
};

test("a known provider is paced at the rate of its API, not at the 60 requests a minute of an unknown one", async () => {
  const steps = 25;
  let requests = 0;
  const usage = { inputTokens: 5, outputTokens: 5 };
  const adapter: ProviderAdapter = {
    family: "fake",
    async *stream(): AsyncIterable<StreamEvent> {
      requests += 1;
      if (requests <= steps) {
        yield { type: "tool_call_start", id: `call-${requests}`, name: "note" };
        yield { type: "tool_call_delta", id: `call-${requests}`, inputJsonDelta: "{}" };
        yield { type: "tool_call_end", id: `call-${requests}` };
        yield { type: "message_stop", stopReason: "tool_use", usage };
        return;
      }
      yield { type: "text_delta", text: "done" };
      yield { type: "message_stop", stopReason: "end_turn", usage };
    },
  };
  const note: ToolSpec = {
    name: "note",
    description: "Records a note.",
    inputSchema: { type: "object", properties: {} },
    riskTier: "safe",
    handler: async () => ({ content: "noted" }),
  };
  const workspaceRoot = tmp("ws");
  daemon = await createAgentDaemon({
    workspaceRoot,
    configDir: tmp("cfg"),
    trustStorePath: join(tmp("trust"), "trust.json"),
    instanceFile: join(workspaceRoot, ".agency", "instance.json"),
    sessionsDir: tmp("sess"),
    adapterFor: () => adapter,
    http: { fetch: async () => new Response() } satisfies HttpClient,
    tools: [note],
  });
  client = await connectToDaemon(daemon.server.port, "127.0.0.1", { token: daemon.server.token });

  const started = Date.now();
  const result = (await client.call("session_send", {
    sessionId: "rate-s1",
    provider: "openrouter",
    model: "test-model",
    systemPrompt: "sys",
    userText: "take notes",
    maxSteps: steps + 5,
  })) as { stopReason: string };
  expect(result.stopReason).toBe("end_turn");
  expect(requests).toBe(steps + 1);
  // At 60 a minute the bucket holds 6 requests and the other 20 wait 1 s each.
  expect(Date.now() - started).toBeLessThan(8_000);
}, 40_000);
